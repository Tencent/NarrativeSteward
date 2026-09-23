"""试玩情景解析：校验版本并用正式项目图重放实际边路线。

只服务当前 Agent 回合的 ``[系统试玩]`` 说明，不写项目、不写聊天、不产生正式检测结论。
见 DESIGN §5.6.1。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from narrative_forge.core.models.event_graph import EventEdge, EventGraph, StateCondition, StateVariable
from narrative_forge.core.models.runtime import apply_effects, eval_condition, find_entry, init_vars
from narrative_forge.core.models.scene_graph import SceneEdge, SceneGraph
from narrative_forge.core.store import ProjectStore

PLAYTEST_NOTE_PREFIX = "[系统试玩]"

REASON_STALE = "stale_version"
REASON_MISSING = "missing_graph"
REASON_INVALID = "invalid_route"
REASON_MISMATCH = "mismatch"


@dataclass(frozen=True)
class PlaytestTakenEdge:
    """一条实际经过的图边。"""

    kind: str
    edge_id: str


@dataclass
class PlaytestContextInput:
    """前端提交、尚未重放的试玩情景。"""

    status: str = "playing"
    phase: str = "scene"
    revisions: dict[str, int] = field(default_factory=dict)
    scene_revisions: dict[str, int] = field(default_factory=dict)
    event_id: str = ""
    beat_id: str = ""
    vars: dict[str, Any] = field(default_factory=dict)
    taken_edges: list[PlaytestTakenEdge] = field(default_factory=list)
    focus_edge_id: str = ""


def playtest_context_from_mapping(payload: Any) -> PlaytestContextInput:
    """把请求模型或字典收成核心层输入。"""
    current = getattr(payload, "current", None)
    if current is None and isinstance(payload, dict):
        current = payload.get("current") or {}
    taken = getattr(payload, "taken_edges", None)
    if taken is None and isinstance(payload, dict):
        taken = payload.get("taken_edges") or []
    revisions = getattr(payload, "revisions", None)
    if revisions is None and isinstance(payload, dict):
        revisions = payload.get("revisions") or {}
    scene_revisions = getattr(payload, "scene_revisions", None)
    if scene_revisions is None and isinstance(payload, dict):
        scene_revisions = payload.get("scene_revisions") or {}
    edges: list[PlaytestTakenEdge] = []
    for item in taken or []:
        kind = getattr(item, "kind", None) or (item.get("kind") if isinstance(item, dict) else "")
        edge_id = getattr(item, "edge_id", None) or (item.get("edge_id") if isinstance(item, dict) else "")
        if kind and edge_id:
            edges.append(PlaytestTakenEdge(kind=str(kind), edge_id=str(edge_id)))
    return PlaytestContextInput(
        status=str(getattr(payload, "status", None) or (payload.get("status") if isinstance(payload, dict) else "") or "playing"),
        phase=str(getattr(payload, "phase", None) or (payload.get("phase") if isinstance(payload, dict) else "") or "scene"),
        revisions={str(key): int(value) for key, value in dict(revisions or {}).items()},
        scene_revisions={str(key): int(value) for key, value in dict(scene_revisions or {}).items()},
        event_id=str(getattr(current, "event_id", None) or (current.get("event_id") if isinstance(current, dict) else "") or ""),
        beat_id=str(getattr(current, "beat_id", None) or (current.get("beat_id") if isinstance(current, dict) else "") or ""),
        vars=dict(getattr(payload, "vars", None) or (payload.get("vars") if isinstance(payload, dict) else {}) or {}),
        taken_edges=edges,
        focus_edge_id=str(
            getattr(payload, "focus_edge_id", None)
            or (payload.get("focus_edge_id") if isinstance(payload, dict) else "")
            or ""
        ),
    )


@dataclass
class PlaytestChoiceView:
    """一条出边在某次分叉或当前位置的可读摘要。"""

    kind: str
    edge_id: str
    label: str
    enabled: bool
    chosen: bool = False
    condition_text: str = ""


@dataclass
class PlaytestForkView:
    """路线上一个历史分叉：当时的全部出边与实际选择。"""

    layer: str
    event_id: str
    beat_id: str
    chosen_edge_id: str
    alternatives: list[PlaytestChoiceView]


@dataclass
class PlaytestContextResolution:
    """解析后的试玩情景；``ok=False`` 时只保留失败原因。"""

    ok: bool
    reason: str | None = None
    status: str = ""
    phase: str = ""
    event_id: str = ""
    beat_id: str = ""
    event_title: str = ""
    beat_kind: str = ""
    beat_content: str = ""
    speaker_id: str = ""
    speaker_name: str = ""
    location_id: str = ""
    location_name: str = ""
    vars: dict[str, Any] = field(default_factory=dict)
    var_labels: dict[str, str] = field(default_factory=dict)
    current_choices: list[PlaytestChoiceView] = field(default_factory=list)
    forks: list[PlaytestForkView] = field(default_factory=list)
    focus_edge_id: str = ""
    at_event_boundary: bool = False


def _fail(reason: str) -> PlaytestContextResolution:
    """构造不可用结果。"""
    return PlaytestContextResolution(ok=False, reason=reason)


def _revision_maps_equal(left: dict[str, int] | None, right: dict[str, int] | None) -> bool:
    """比较两份 revision 映射；缺键视为 0。"""
    keys = set(left or {}) | set(right or {})
    return all(int((left or {}).get(key) or 0) == int((right or {}).get(key) or 0) for key in keys)


def _load_scene(store: ProjectStore, project_id: str, event_id: str) -> SceneGraph | None:
    """读取并解析一张情节图；缺失或非法时返回 ``None``。"""
    raw = store.get_scene(project_id, event_id)
    if not raw:
        return None
    try:
        return SceneGraph.model_validate(raw)
    except Exception:
        return None


def _card_name(world: dict[str, Any], card_id: str) -> str:
    """按卡片 id 取显示名。"""
    if not card_id:
        return ""
    for category in ("characters", "locations", "factions", "history", "worldview", "other"):
        for card in world.get(category) or []:
            if card.get("id") == card_id:
                return str(card.get("name") or card_id)
    return card_id


def _format_condition(
    condition: StateCondition | None,
    vars_: dict[str, Any],
    var_by_id: dict[str, StateVariable],
) -> str:
    """把边条件写成短句。"""
    if condition is None:
        return "无条件"
    declaration = var_by_id.get(condition.var)
    name = declaration.name if declaration is not None else condition.var
    actual = vars_.get(condition.var)
    return f"{name}（{condition.var}）{condition.op} {condition.value}（当前 {actual}）"


def _edge_label(edge: EventEdge | SceneEdge, fallback: str) -> str:
    """优先使用选项文案，否则退回目标 id。"""
    return edge.label.strip() if edge.label else fallback


def _choice_view(
    kind: str,
    edge: EventEdge | SceneEdge,
    vars_: dict[str, Any],
    var_by_id: dict[str, StateVariable],
    *,
    chosen: bool = False,
    fallback: str = "",
) -> PlaytestChoiceView:
    """把一条出边编成可读选项。"""
    enabled = eval_condition(edge.condition, vars_)
    return PlaytestChoiceView(
        kind=kind,
        edge_id=edge.id,
        label=_edge_label(edge, fallback or edge.target),
        enabled=enabled,
        chosen=chosen,
        condition_text="" if enabled else _format_condition(edge.condition, vars_, var_by_id),
    )


def _vars_equal(
    client: dict[str, Any],
    replayed: dict[str, Any],
    declarations: list[StateVariable],
) -> bool:
    """只比较已声明变量；客户端缺键或取值不同则失败。"""
    for variable in declarations:
        if variable.id not in client:
            return False
        if client[variable.id] != replayed.get(variable.id):
            return False
    return True


def replay_playtest_route(
    events: EventGraph,
    load_scene: Callable[[str], SceneGraph | None],
    taken_edges: list[PlaytestTakenEdge],
    *,
    phase: str = "scene",
) -> PlaytestContextResolution:
    """从入口按实际边路线重放，并记录各历史分叉的未选选项。

    Args:
        events: 正式事件图。
        load_scene: 按事件 id 读取情节图。
        taken_edges: 浏览器报告的实际经过边。
        phase: 发送瞬间的试玩相位，用于决定当前选项属于情节层还是事件层。

    Returns:
        重放成功时 ``ok=True`` 并带当前位置；失败时只含原因。
    """
    var_by_id = {variable.id: variable for variable in events.state_variables}
    node_by_id = {node.id: node for node in events.nodes}
    vars_ = init_vars(events.state_variables)
    entry = find_entry([node.id for node in events.nodes], events.edges)
    if not entry:
        return _fail(REASON_INVALID)

    event_id = entry
    scene = load_scene(event_id)
    beat_id = ""
    forks: list[PlaytestForkView] = []

    if scene and scene.beats:
        beat_id = find_entry([beat.id for beat in scene.beats], scene.edges) or ""
        beat = next((item for item in scene.beats if item.id == beat_id), None)
        if beat is None:
            return _fail(REASON_INVALID)
        vars_ = apply_effects(vars_, beat.effects, events.state_variables)

    for step in taken_edges:
        if step.kind == "scene":
            if scene is None or not beat_id:
                return _fail(REASON_INVALID)
            edge = next((item for item in scene.edges if item.id == step.edge_id), None)
            if edge is None or edge.source != beat_id:
                return _fail(REASON_INVALID)
            outs = [item for item in scene.edges if item.source == beat_id]
            forks.append(
                PlaytestForkView(
                    layer="scene",
                    event_id=event_id,
                    beat_id=beat_id,
                    chosen_edge_id=edge.id,
                    alternatives=[
                        _choice_view(
                            "scene",
                            item,
                            vars_,
                            var_by_id,
                            chosen=item.id == edge.id,
                            fallback=item.target,
                        )
                        for item in outs
                    ],
                )
            )
            if not eval_condition(edge.condition, vars_):
                return _fail(REASON_INVALID)
            beat_id = edge.target
            beat = next((item for item in scene.beats if item.id == beat_id), None)
            if beat is None:
                return _fail(REASON_INVALID)
            vars_ = apply_effects(vars_, beat.effects, events.state_variables)
            continue

        remaining = [item for item in (scene.edges if scene else []) if item.source == beat_id] if beat_id else []
        if remaining:
            return _fail(REASON_INVALID)
        edge = next((item for item in events.edges if item.id == step.edge_id), None)
        if edge is None or edge.source != event_id:
            return _fail(REASON_INVALID)
        outs = [item for item in events.edges if item.source == event_id]
        forks.append(
            PlaytestForkView(
                layer="event",
                event_id=event_id,
                beat_id=beat_id,
                chosen_edge_id=edge.id,
                alternatives=[
                    _choice_view(
                        "event",
                        item,
                        vars_,
                        var_by_id,
                        chosen=item.id == edge.id,
                        fallback=node_by_id[item.target].title if item.target in node_by_id else item.target,
                    )
                    for item in outs
                ],
            )
        )
        if not eval_condition(edge.condition, vars_):
            return _fail(REASON_INVALID)
        event_id = edge.target
        scene = load_scene(event_id)
        beat_id = ""
        if scene and scene.beats:
            beat_id = find_entry([beat.id for beat in scene.beats], scene.edges) or ""
            beat = next((item for item in scene.beats if item.id == beat_id), None)
            if beat is None:
                return _fail(REASON_INVALID)
            vars_ = apply_effects(vars_, beat.effects, events.state_variables)

    scene_outs = [item for item in (scene.edges if scene else []) if item.source == beat_id] if beat_id else []
    event_outs = [item for item in events.edges if item.source == event_id]
    at_boundary = bool(beat_id and not scene_outs and phase in {"event_boundary", "playing", "scene"})
    if phase == "event_transition":
        current_choices = [
            _choice_view(
                "event",
                item,
                vars_,
                var_by_id,
                fallback=node_by_id[item.target].title if item.target in node_by_id else item.target,
            )
            for item in event_outs
        ]
        at_boundary = False
    elif scene_outs:
        current_choices = [
            _choice_view("scene", item, vars_, var_by_id, fallback=item.target) for item in scene_outs
        ]
    else:
        current_choices = [
            _choice_view(
                "event",
                item,
                vars_,
                var_by_id,
                fallback=node_by_id[item.target].title if item.target in node_by_id else item.target,
            )
            for item in event_outs
        ]
        at_boundary = bool(beat_id and not scene_outs)

    node = node_by_id.get(event_id)
    beat = next((item for item in (scene.beats if scene else []) if item.id == beat_id), None)
    return PlaytestContextResolution(
        ok=True,
        status="",
        phase=phase,
        event_id=event_id,
        beat_id=beat_id,
        event_title=node.title if node is not None else event_id,
        beat_kind=beat.kind if beat is not None else "",
        beat_content=beat.content if beat is not None else "",
        speaker_id=beat.speaker if beat is not None else "",
        location_id=beat.location if beat is not None else "",
        vars=vars_,
        var_labels={variable.id: variable.name or variable.id for variable in events.state_variables},
        current_choices=current_choices,
        forks=forks,
        at_event_boundary=at_boundary,
    )


def resolve_playtest_context(
    store: ProjectStore,
    project_id: str,
    context: PlaytestContextInput,
) -> PlaytestContextResolution:
    """校验版本并重放浏览器提交的实际边路线。

    Args:
        store: 项目存储。
        project_id: 当前项目。
        context: 请求中的试玩情景。

    Returns:
        可用情景或带原因的不可用结果。语义失败不抛错。
    """
    try:
        meta = store.load_meta(project_id)
    except FileNotFoundError:
        return _fail(REASON_MISSING)
    if not _revision_maps_equal(context.revisions, meta.revisions) or not _revision_maps_equal(
        context.scene_revisions,
        meta.scene_revisions,
    ):
        return _fail(REASON_STALE)

    raw_events = store.get_data(project_id, "events")
    if not raw_events:
        return _fail(REASON_MISSING)
    try:
        events = EventGraph.model_validate(raw_events)
    except Exception:
        return _fail(REASON_MISSING)

    world = store.get_data(project_id, "world") or {}
    resolved = replay_playtest_route(
        events,
        lambda event_id: _load_scene(store, project_id, event_id),
        list(context.taken_edges),
        phase=context.phase,
    )
    if not resolved.ok:
        return resolved

    if context.event_id and context.event_id != resolved.event_id:
        return _fail(REASON_MISMATCH)
    if context.beat_id and context.beat_id != resolved.beat_id:
        return _fail(REASON_MISMATCH)
    if context.vars and not _vars_equal(context.vars, resolved.vars, events.state_variables):
        return _fail(REASON_MISMATCH)

    resolved.status = context.status
    resolved.speaker_name = _card_name(world, resolved.speaker_id)
    resolved.location_name = _card_name(world, resolved.location_id)
    resolved.focus_edge_id = (context.focus_edge_id or "").strip()
    return resolved


def format_playtest_note(resolution: PlaytestContextResolution) -> str:
    """把解析结果编成只进当前回合的 ``[系统试玩]`` 说明。"""
    if not resolution.ok:
        reason = {
            REASON_STALE: "试玩开局版本已与当前正式内容不同",
            REASON_MISSING: "当前项目缺少可重放的事件或情节",
            REASON_INVALID: "提交的实际路线无法在正式项目图上连续重放",
            REASON_MISMATCH: "重放后的位置或变量与浏览器快照不一致",
        }.get(resolution.reason or "", "试玩情景无法核对")
        return (
            f"{PLAYTEST_NOTE_PREFIX}\n"
            f"用户试图附带试玩情景，但该上下文不可用：{reason}。"
            "不要声称知道“这里”具体指哪个节点或选项；请用户重新开始试玩或明确点名对象。"
        )

    lines = [
        PLAYTEST_NOTE_PREFIX,
        "用户正在试玩板块。以下是发送瞬间的位置，只用于理解“这句 / 这里 / 这个选项”。",
        f"当前位置：事件「{resolution.event_title}」（{resolution.event_id}）",
    ]
    if resolution.beat_id:
        kind = resolution.beat_kind or "节点"
        lines.append(f"当前情节节点：{resolution.beat_id}（{kind}）")
        if resolution.beat_content:
            lines.append(f"当前正文：{resolution.beat_content}")
    if resolution.speaker_id:
        speaker = resolution.speaker_name or resolution.speaker_id
        lines.append(f"说话人：{speaker}（{resolution.speaker_id}）")
    if resolution.location_id:
        location = resolution.location_name or resolution.location_id
        lines.append(f"地点：{location}（{resolution.location_id}）")
    if resolution.vars:
        rendered = []
        for key, value in resolution.vars.items():
            label = resolution.var_labels.get(key, key)
            rendered.append(f"{label}（{key}）={value}")
        lines.append("当前状态：" + "；".join(rendered))
    if resolution.at_event_boundary:
        lines.append("当前停在该事件的终止情节节点，玩家尚未进入事件层转移。")
    if resolution.current_choices:
        heading = "随后事件层选项：" if resolution.at_event_boundary else "当前选项："
        lines.append(heading)
        for choice in resolution.current_choices:
            state = "可用" if choice.enabled else f"未解锁：{choice.condition_text}"
            lines.append(f"- {choice.kind} `{choice.edge_id}`「{choice.label}」{state}")
    if resolution.focus_edge_id:
        lines.append(f"用户精确引用了边 `{resolution.focus_edge_id}`，解释“这个选项”时优先用它。")
    if resolution.forks:
        lines.append("本局实际路线（每个分叉列出当时全部出边）：")
        for index, fork in enumerate(resolution.forks, start=1):
            chosen = next(
                (item for item in fork.alternatives if item.chosen),
                None,
            )
            chosen_text = (
                f"选择 {fork.layer} `{fork.chosen_edge_id}`「{chosen.label}」"
                if chosen
                else f"选择 {fork.layer} `{fork.chosen_edge_id}`"
            )
            lines.append(
                f"{index}. 在事件 {fork.event_id}"
                + (f" / 节点 {fork.beat_id}" if fork.beat_id else "")
                + f" {chosen_text}"
            )
            for alt in fork.alternatives:
                if alt.chosen:
                    continue
                state = "可用未选" if alt.enabled else f"当时未解锁：{alt.condition_text}"
                lines.append(f"   - 未走 {alt.kind} `{alt.edge_id}`「{alt.label}」{state}")
    lines.append(
        "修改前按上述稳定 id 读取正式创作文件。"
        "用户明确点名的其它对象优先；多个候选且无精确引用时先询问，不要猜测。"
        "此说明只描述发送瞬间，回合结束后即失效。"
    )
    return "\n".join(lines)
