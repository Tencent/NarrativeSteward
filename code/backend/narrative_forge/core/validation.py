"""数据片段的 schema 校验。

把 data_type 映射到对应的 Pydantic 模型，提供统一的校验入口。供编排层"回合末
硬校验"使用：Agent 用内置文件工具直接写 JSON 后，这里负责判定是否符合契约，并把
不合规的报错整理成可读文本回传给 Agent 自纠。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from narrative_forge.core.models import EventGraph, SceneGraph, StateVariable, WorldSetting
from narrative_forge.core.models.compact_propagation import (
    CompactModelError,
    propagate_compact_states,
)
from narrative_forge.core.models.event_graph import validate_event_graph_structure
from narrative_forge.core.models.reachability import check_numeric_reachability
from narrative_forge.core.models.scalar_contract import validate_scalar_contract
from narrative_forge.core.models.scene_graph import validate_scene_graph_structure
from narrative_forge.core.models.simulation import (
    DEFAULT_MAX_CONFIGS,
    DEFAULT_MAX_DEPTH,
    simulate_playability,
)
from narrative_forge.core.models.state_validation import (
    ENGINE_VERSION as STATE_ENGINE_VERSION,
    REPORT_SCHEMA_VERSION as STATE_REPORT_SCHEMA_VERSION,
    build_incomplete_state_validation_report,
    build_preflight_failure_report,
    build_state_validation_report,
)
from narrative_forge.core.speaker_references import (
    ambiguous_world_card_ids,
    build_world_card_index,
    collect_duplicate_world_card_id_errors,
    collect_world_card_reference_errors,
    unique_world_card_ids,
)

# data_type → Pydantic 模型。
# 注：``outline`` 为自由 Markdown 文本（不强校验），故不在此表中；``scenes`` 因需跨片段读取
# 事件层状态变量做引用校验，走独立入口 :func:`validate_scene`（不在本表）。
MODEL_BY_TYPE: dict[str, type[BaseModel]] = {
    "world": WorldSetting,
    "events": EventGraph,
}


@dataclass
class ValidationIssue:
    """一条可反馈给 Agent 的基础验收错误。

    Attributes:
        key: 片段键，如 ``world`` 或 ``scene:ev-1``。
        path: 字段路径；整文件问题时为空。
        rule: 规则名，如 ``schema`` / ``reference`` / ``graph`` / ``scalar``。
        message: 人类可读说明。
    """

    key: str
    path: str
    rule: str
    message: str

    def as_feedback(self) -> str:
        """格式化为 Agent 可读的一行错误。"""
        loc = f" 字段 `{self.path}`" if self.path else ""
        return f"- [{self.rule}]{loc}：{self.message}"


@dataclass
class TurnValidationReport:
    """一次回合草稿基础验收的结果。"""

    issues: list[ValidationIssue] = field(default_factory=list)
    changed_keys: list[str] = field(default_factory=list)
    deleted_keys: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """没有任何硬错误时为 True。"""
        return not self.issues

    def as_invalid_map(self) -> dict[str, str]:
        """按片段键合并为旧式 ``{key: 多行说明}``，供修复反馈复用。"""
        grouped: dict[str, list[str]] = {}
        for issue in self.issues:
            grouped.setdefault(issue.key, []).append(issue.as_feedback())
        return {key: "\n".join(lines) for key, lines in grouped.items()}


def validate_data(
    data_type: str,
    data: dict,
) -> tuple[bool, str]:
    """校验某数据片段是否符合其 schema。

    Args:
        data_type: 数据类型（须在 :data:`MODEL_BY_TYPE` 中）。
        data: 待校验的 dict（通常来自读取磁盘上的 JSON）。

    Returns:
        ``(ok, message)``：合法时 ``ok=True``、``message=""``；非法时 ``ok=False``，
        ``message`` 为人类可读的错误说明（含字段路径），便于回传给 Agent 修正。
    """
    model = MODEL_BY_TYPE.get(data_type)
    if model is None:
        return False, f"未知 data_type: {data_type}"
    try:
        obj = model.model_validate(data)
    except ValidationError as exc:
        return False, _format_errors(exc)
    # 字段校验之外的图级结构性校验（目前仅事件图，见 DESIGN §4.2(h)）。
    if data_type == "events":
        struct_errors = validate_event_graph_structure(obj)  # type: ignore[arg-type]
        struct_errors.extend(validate_scalar_contract(obj, []))  # type: ignore[arg-type]
        if struct_errors:
            return False, "\n".join(f"- {e}" for e in struct_errors)
    return True, ""


def _speaker_card_id_sets(
    world_data: dict | None,
) -> tuple[set[str] | None, set[str] | None]:
    """从世界设定抽出 speaker 硬引用所需的唯一/歧义卡片 id。

    Args:
        world_data: ``world.json`` 原始字典。为 ``None`` 时表示调用方不检查成员资格。

    Returns:
        ``(unique_ids, ambiguous_ids)``；``world_data is None`` 时两项皆为 ``None``。
    """
    if world_data is None:
        return None, None
    index = build_world_card_index(world_data)
    return unique_world_card_ids(index), ambiguous_world_card_ids(index)


def validate_scene(
    scene_data: dict,
    state_variables: list[dict],
    world_locations: list[dict] | None = None,
    expected_event_id: str | None = None,
    world_data: dict | None = None,
) -> tuple[bool, str]:
    """校验某事件的场景图（阶段 4）：Pydantic 字段 + 图结构 + effect/condition/地点/发言人引用。

    场景图的 effect / 边条件引用的状态变量在**事件层**声明（``events.json`` 的
    ``state_variables``），beat 的 ``location`` 引用**世界设定**的地点卡片（``world.json`` 的
    ``locations``），``speaker`` 引用六类设定中全局唯一的卡片 id，故本函数额外接收世界设定
    用于引用校验（见 DESIGN §4.2(h)、§4.5、§5.8(b)）。

    Args:
        scene_data: 待校验的场景图 dict（通常来自磁盘 ``scenes/<event_id>.json``）。
        state_variables: 事件层的状态变量声明（dict 列表，来自 ``events.json``）；
            解析失败的变量会被跳过（引用校验退化为"未声明"报错，从而暴露问题）。
        world_locations: 世界设定 ``locations`` 分类的地点卡片（dict 列表，来自 ``world.json``）；
            用于 beat.location 硬引用校验。为 ``None`` 时跳过"地点是否存在"的成员校验（仍强制非空）。
        expected_event_id: 调用方已知的所属事件 id（如 URL 中的 id）。提供时要求与 JSON 内
            ``event_id`` 一致，防止把一张情节图保存到错误事件名下。
        world_data: 完整世界设定。提供时校验 ``dialogue``/``monologue`` 的 speaker 必须是
            六类卡片中全局唯一的 id；为 ``None`` 时仍检查发言人是否该填，但跳过成员校验。

    Returns:
        ``(ok, message)``：合法时 ``ok=True``；非法时 ``message`` 为可读错误说明。
    """
    try:
        graph = SceneGraph.model_validate(scene_data)
    except ValidationError as exc:
        return False, _format_errors(exc)
    if expected_event_id is not None and graph.event_id != expected_event_id:
        return (
            False,
            f"- 字段 `event_id`：内容声明为 {graph.event_id!r}，"
            f"但当前保存目标是 {expected_event_id!r}",
        )

    svars: list[StateVariable] = []
    for v in state_variables:
        try:
            svars.append(StateVariable.model_validate(v))
        except ValidationError:
            continue  # 事件层若有非法变量另由 events 校验暴露，这里只用合法的做引用检查

    loc_ids: set[str] | None = None
    if world_locations is not None:
        loc_ids = {
            c["id"]
            for c in world_locations
            if isinstance(c, dict) and c.get("id")
        }
    world_card_ids, ambiguous_card_ids = _speaker_card_id_sets(world_data)
    struct_errors = validate_scene_graph_structure(
        graph,
        svars,
        loc_ids,
        world_card_ids,
        ambiguous_card_ids,
    )
    struct_errors.extend(
        validate_scalar_contract(
            EventGraph(state_variables=svars),
            [graph],
        )
    )
    if struct_errors:
        return False, "\n".join(f"- {e}" for e in struct_errors)
    return True, ""


def validate_project_scalar_contract(
    events_data: dict | None,
    scenes_data: list[dict],
) -> tuple[bool, str]:
    """校验候选事件图与全部 scene 组成的 scalar 完整视图。

    Args:
        events_data: 当前或候选 ``events.json``。
        scenes_data: 当前或候选的全部 scene。

    Returns:
        ``(ok, message)``；非法 schema 仍由片段自身校验负责，本函数只返回可解析内容的契约问题。
    """
    if not isinstance(events_data, dict):
        return False, "事件网络缺失，无法校验 scalar"
    try:
        graph = EventGraph.model_validate(events_data)
    except ValidationError:
        return False, "事件网络非法，无法校验 scalar"
    scenes: list[SceneGraph] = []
    for scene_data in scenes_data:
        try:
            scenes.append(SceneGraph.model_validate(scene_data))
        except ValidationError:
            continue
    errors = validate_scalar_contract(graph, scenes)
    if errors:
        return False, "\n".join(f"- {error}" for error in errors)
    return True, ""


def validate_project_draft(
    *,
    world_data: dict | None,
    events_data: dict | None,
    scenes: dict[str, dict | None],
    world_raw_error: str | None = None,
    events_raw_error: str | None = None,
    scene_raw_errors: dict[str, str] | None = None,
    deleted_keys: list[str] | None = None,
) -> list[ValidationIssue]:
    """对一份项目草稿做基础硬校验（schema、引用、图结构、scalar 契约）。

    不运行完整状态传播。``intent`` / ``outline`` 不在此检查叙事质量。

    Args:
        world_data: 可解析的世界设定；缺失为 ``None``。
        events_data: 可解析的事件图；缺失为 ``None``。
        scenes: ``event_id → scene dict``；值为 ``None`` 表示该文件无法解析或已删除。
        world_raw_error: world.json 无法解析时的说明。
        events_raw_error: events.json 无法解析时的说明。
        scene_raw_errors: 无法解析的 scene 文件说明。
        deleted_keys: 本轮删除的片段键。删除 ``world``/``events`` 且仍被引用时记为错误。

    Returns:
        硬错误列表；空列表表示基础验收通过。
    """
    issues: list[ValidationIssue] = []
    deleted = set(deleted_keys or [])
    scene_errors = scene_raw_errors or {}

    if "world" in deleted and any(
        isinstance(scene, dict) for scene in scenes.values()
    ):
        issues.append(
            ValidationIssue(
                key="world",
                path="",
                rule="reference",
                message="删除世界设定后仍有情节文件，地点引用将全部失效",
            )
        )
    if world_raw_error:
        issues.append(
            ValidationIssue(key="world", path="", rule="json", message=world_raw_error)
        )
    elif isinstance(world_data, dict):
        ok, msg = validate_data("world", world_data)
        if not ok:
            issues.extend(_issues_from_message("world", "schema", msg))

    if "events" in deleted and any(
        isinstance(scene, dict) for scene in scenes.values()
    ):
        issues.append(
            ValidationIssue(
                key="events",
                path="",
                rule="reference",
                message="删除事件网络后仍有情节文件，无法核对事件归属与状态变量",
            )
        )
    if events_raw_error:
        issues.append(
            ValidationIssue(key="events", path="", rule="json", message=events_raw_error)
        )
    elif isinstance(events_data, dict):
        ok, msg = validate_data("events", events_data)
        if not ok:
            issues.extend(_issues_from_message("events", "graph", msg))

    world_locations = []
    speaker_world: dict | None = None
    if isinstance(world_data, dict):
        speaker_world = world_data
        locs = world_data.get("locations")
        if isinstance(locs, list):
            world_locations = locs
    state_variables = []
    if isinstance(events_data, dict):
        svars = events_data.get("state_variables")
        if isinstance(svars, list):
            state_variables = svars
    event_ids = set()
    if isinstance(events_data, dict):
        event_ids = {
            node.get("id")
            for node in events_data.get("nodes", [])
            if isinstance(node, dict) and node.get("id")
        }

    parsed_scenes: list[dict] = []
    for event_id, scene in scenes.items():
        key = f"scene:{event_id}"
        if key in deleted or scene is None and key in deleted:
            continue
        if event_id in scene_errors:
            issues.append(
                ValidationIssue(
                    key=key,
                    path="",
                    rule="json",
                    message=scene_errors[event_id],
                )
            )
            continue
        if scene is None:
            continue
        if event_ids and event_id not in event_ids:
            issues.append(
                ValidationIssue(
                    key=key,
                    path="event_id",
                    rule="reference",
                    message=f"事件图中不存在事件 {event_id}，不能保存其情节",
                )
            )
        ok, msg = validate_scene(
            scene,
            state_variables,
            world_locations,
            expected_event_id=event_id,
            world_data=speaker_world if speaker_world is not None else {},
        )
        if not ok:
            issues.extend(_issues_from_message(key, "graph", msg))
        else:
            parsed_scenes.append(scene)

    if isinstance(world_data, dict) and not world_raw_error:
        draft_scenes = [
            scene
            for scene in scenes.values()
            if isinstance(scene, dict)
        ]
        for message in collect_world_card_reference_errors(world_data, draft_scenes):
            issues.append(
                ValidationIssue(
                    key="world",
                    path="",
                    rule="reference",
                    message=message,
                )
            )

    if isinstance(events_data, dict) and not events_raw_error:
        ok, msg = validate_project_scalar_contract(events_data, parsed_scenes)
        if not ok:
            issues.extend(_issues_from_message("events", "scalar", msg))
    return issues


def _issues_from_message(key: str, rule: str, message: str) -> list[ValidationIssue]:
    """把多行 ``- 字段`` 说明拆成独立问题。"""
    issues: list[ValidationIssue] = []
    for line in (message or "").splitlines():
        text = line.strip()
        if text.startswith("- "):
            text = text[2:]
        if not text:
            continue
        path = ""
        if "字段 `" in text:
            start = text.find("`") + 1
            end = text.find("`", start)
            if end > start:
                path = text[start:end]
        issues.append(ValidationIssue(key=key, path=path, rule=rule, message=text))
    if not issues and message:
        issues.append(ValidationIssue(key=key, path="", rule=rule, message=message))
    return issues


def reachability_warnings(
    events_data: dict | None, scenes_data: list[dict]
) -> list[dict]:
    """跨层数值可达性软校验入口（容错解析 dict → 模型后委托给纯函数）。

    这是 warning 级快速提示（见 DESIGN §4.2.1）：把事件图与全部已生成场景图汇总，估各
    scalar 变量的可达上/下界，找出"再乐观也够不到"的事件边阈值。**解析失败的片段直接跳过**
    （其硬校验问题另有入口暴露），本函数只在数据可用时给出可读 warning，绝不抛异常。

    Args:
        events_data: ``events.json`` 内容（含状态变量 + 事件边条件）；缺失/非法时返回 ``[]``。
        scenes_data: 已生成场景图 dict 列表（来自各 ``scenes/<event_id>.json``）；逐个容错解析。

    Returns:
        warning 项列表，每项为 ``{"message", "edge_id", "var"}``（见
        :func:`check_numeric_reachability`）；无数据 / 未发现不可达阈值时为空。
    """
    if not isinstance(events_data, dict):
        return []
    try:
        graph = EventGraph.model_validate(events_data)
    except ValidationError:
        return []  # 事件图本身非法：由 events 硬校验暴露，这里不重复报

    scenes: list[SceneGraph] = []
    for sd in scenes_data:
        try:
            scenes.append(SceneGraph.model_validate(sd))
        except ValidationError:
            continue  # 单张非法场景另由场景硬校验暴露，跳过不影响其余估计
    return check_numeric_reachability(graph, scenes)


def playability_report(
    events_data: dict | None,
    scenes_data: list[dict],
    *,
    max_configs: int | None = DEFAULT_MAX_CONFIGS,
    max_depth: int | None = DEFAULT_MAX_DEPTH,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    progress_every: int = 100_000,
) -> dict:
    """遗留局面去重穷举诊断入口：容错解析 dict → 模型后委托纯函数。

    与 :func:`reachability_warnings` 同款容错策略：**解析失败的片段直接跳过**（其硬校验问题
    另有入口暴露），本函数只在数据可用时给出指标报告，绝不抛异常。不调用任何 LLM，可按需实时触发。

    Args:
        events_data: ``events.json`` 内容（状态变量 + 事件节点 + 事件边）；缺失/非法时返回带
            ``note`` 的空报告。
        scenes_data: 已生成情节图 dict 列表（来自各 ``scenes/<event_id>.json``）；逐个容错解析。
        max_configs: 不同局面数上限；传 ``None`` 表示不按局面数截断。
        max_depth: 单局面最大步深；传 ``None`` 表示不按深度截断。
        progress_callback: 可选进度回调，供离线基准观察状态增长。
        progress_every: 每展开多少个局面调用一次进度回调。

    Returns:
        指标报告 dict（结构见 :func:`simulate_playability`），可直接 JSON 序列化。
    """
    if not isinstance(events_data, dict):
        return {"summary": {"note": "事件图缺失或非法，无法模拟"}, "meta": {"mode": "empty"}}
    try:
        graph = EventGraph.model_validate(events_data)
    except ValidationError:
        return {"summary": {"note": "事件图非法（详见 events 硬校验），无法模拟"}, "meta": {"mode": "empty"}}

    scenes: list[SceneGraph] = []
    for sd in scenes_data:
        try:
            scenes.append(SceneGraph.model_validate(sd))
        except ValidationError:
            continue  # 单张非法场景另由场景硬校验暴露，跳过不影响其余局面推演
    return simulate_playability(
        graph,
        scenes,
        max_configs=max_configs,
        max_depth=max_depth,
        progress_callback=progress_callback,
        progress_every=progress_every,
    )


def compact_playability_report(
    events_data: dict | None,
    scenes_data: list[dict],
    *,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    progress_every: int = 100_000,
) -> dict:
    """运行隔离的紧凑联合状态传播原型。

    本入口只服务算法等价测试和离线基准，不写正式检测记录。输入缺失、schema 非法或不满足有限整数域时，
    返回 ``mode=empty`` 的明确诊断，不把未运行包装成可达性结论。

    Args:
        events_data: ``events.json`` 原始字典。
        scenes_data: 全部 scene 原始字典。
        progress_callback: 可选进度回调。
        progress_every: 每处理多少个位置状态发送一次进度。

    Returns:
        紧凑传播报告；无法运行时返回带 ``note`` 的空报告。
    """
    if not isinstance(events_data, dict):
        return {
            "summary": {"note": "事件图缺失或非法，无法运行紧凑传播"},
            "meta": {"mode": "empty", "complete": False},
        }
    try:
        graph = EventGraph.model_validate(events_data)
    except ValidationError:
        return {
            "summary": {"note": "事件图非法，无法运行紧凑传播"},
            "meta": {"mode": "empty", "complete": False},
        }

    scenes: list[SceneGraph] = []
    for scene_data in scenes_data:
        try:
            scenes.append(SceneGraph.model_validate(scene_data))
        except ValidationError:
            continue
    try:
        return propagate_compact_states(
            graph,
            scenes,
            progress_callback=progress_callback,
            progress_every=progress_every,
        )
    except CompactModelError as exc:
        return {
            "summary": {"note": str(exc)},
            "meta": {"mode": "unsupported", "complete": False},
        }


def state_validation_report(
    events_data: dict | None,
    scenes_data: list[dict],
    *,
    invalid_scene_ids: list[str] | None = None,
    world_data: dict | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    progress_every: int = 100_000,
    cancel_check: Callable[[], None] | None = None,
) -> dict:
    """构建正式联合状态检测报告。

    任一 scene 文件缺失时只做基础结构检查并返回 ``incomplete``，不会运行联合状态传播。内容齐全且
    基础检查通过后才调用紧凑传播；进度与取消检查会继续传入路线还原阶段。

    Args:
        events_data: ``events.json`` 原始字典。
        scenes_data: 当前可解析的 scene 原始字典。
        invalid_scene_ids: 文件存在但不是合法 JSON 的 scene id。
        world_data: ``world.json`` 原始字典，用于 speaker / location 硬引用预检。
        progress_callback: 可选传播进度回调。
        progress_every: 每处理多少个紧凑状态上报一次进度。
        cancel_check: 可选取消检查。

    Returns:
        ``state-propagation/v1`` 正式报告。
    """
    if cancel_check is not None:
        cancel_check()
    if not isinstance(events_data, dict):
        return {
            "engine_version": STATE_ENGINE_VERSION,
            "report_schema_version": STATE_REPORT_SCHEMA_VERSION,
            "status": "incomplete",
            "summary": {"issue_count": 1, "warning_count": 0},
            "issues": [{"kind": "events_missing", "message": "事件网络尚未生成"}],
            "warnings": [],
            "meta": {"complete": True, "propagation_ran": False},
        }
    try:
        graph = EventGraph.model_validate(events_data)
    except ValidationError as exc:
        return {
            "engine_version": STATE_ENGINE_VERSION,
            "report_schema_version": STATE_REPORT_SCHEMA_VERSION,
            "status": "failed",
            "summary": {"issue_count": 1, "warning_count": 0},
            "issues": [
                {
                    "kind": "events_invalid",
                    "message": f"事件网络不符合当前 schema：{_format_errors(exc)}",
                }
            ],
            "warnings": [],
            "meta": {"complete": True, "propagation_ran": False},
        }

    scenes: list[SceneGraph] = []
    invalid_ids = set(invalid_scene_ids or [])
    for scene_data in scenes_data:
        try:
            scenes.append(SceneGraph.model_validate(scene_data))
        except ValidationError:
            event_id = (
                scene_data.get("event_id")
                if isinstance(scene_data, dict)
                else None
            )
            invalid_ids.add(str(event_id or "unknown"))

    issues: list[dict[str, Any]] = []
    for message in validate_event_graph_structure(graph):
        issues.append({"kind": "event_structure_invalid", "message": message})

    if isinstance(world_data, dict):
        world_card_ids, ambiguous_card_ids = _speaker_card_id_sets(world_data)
        location_ids = {
            card["id"]
            for card in world_data.get("locations", [])
            if isinstance(card, dict) and card.get("id")
        }
        for message in collect_duplicate_world_card_id_errors(world_data):
            issues.append(
                {
                    "kind": "world_card_id_ambiguous",
                    "message": message,
                }
            )
    else:
        world_card_ids = None
        ambiguous_card_ids = None
        location_ids = None

    expected_ids = {node.id for node in graph.nodes}
    seen_scene_ids: set[str] = set()
    for scene in scenes:
        if scene.event_id not in expected_ids:
            issues.append(
                {
                    "kind": "scene_event_unknown",
                    "message": f"情节引用了事件网络中不存在的事件 {scene.event_id}",
                    "event_id": scene.event_id,
                }
            )
        if scene.event_id in seen_scene_ids:
            issues.append(
                {
                    "kind": "scene_duplicate",
                    "message": f"事件 {scene.event_id} 存在重复情节",
                    "event_id": scene.event_id,
                }
            )
        seen_scene_ids.add(scene.event_id)
        for message in validate_scene_graph_structure(
            scene,
            graph.state_variables,
            location_ids,
            world_card_ids,
            ambiguous_card_ids,
        ):
            issues.append(
                {
                    "kind": "scene_structure_invalid",
                    "message": f"事件 {scene.event_id}：{message}",
                    "event_id": scene.event_id,
                }
            )

    for event_id in sorted(invalid_ids):
        issues.append(
            {
                "kind": "scene_invalid",
                "message": f"事件 {event_id} 的情节文件不是合法 JSON 或不符合当前 schema",
                "event_id": event_id,
            }
        )
    issues.extend(
        {
            "kind": "scalar_contract_invalid",
            "message": message,
        }
        for message in validate_scalar_contract(graph, scenes)
    )

    truly_missing = expected_ids - seen_scene_ids - invalid_ids
    if truly_missing:
        return build_incomplete_state_validation_report(
            graph,
            scenes,
            extra_issues=issues,
            missing_scene_ids=truly_missing,
            world_data=world_data,
        )
    if issues:
        return build_preflight_failure_report(
            graph, scenes, issues, world_data=world_data
        )

    if cancel_check is not None:
        cancel_check()
    try:
        return build_state_validation_report(
            graph,
            scenes,
            progress_callback=progress_callback,
            progress_every=progress_every,
            cancel_check=cancel_check,
            world_data=world_data,
        )
    except CompactModelError as exc:
        return build_preflight_failure_report(
            graph,
            scenes,
            [
                {
                    "kind": "unsupported_state_model",
                    "message": str(exc),
                }
            ],
            world_data=world_data,
        )


def _format_errors(exc: ValidationError) -> str:
    """把 Pydantic 的 ValidationError 整理为简洁的逐条说明。"""
    lines: list[str] = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()))
        msg = err.get("msg", "")
        lines.append(f"- 字段 `{loc or '<root>'}`：{msg}")
    return "\n".join(lines)
