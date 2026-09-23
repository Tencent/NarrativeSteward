"""场景/情节图（Scene Graph）数据模型 —— 四阶段流水线的"场景生成"阶段（阶段 4）产出。

对应 DESIGN §4.2「图 + 状态变量」叙事模型的**场景层（阶段 4）**。每个事件对应一张
场景图，是**真正可玩的状态机**，也是**唯一写状态（effects）的地方**：

- :class:`Effect`：一次状态写入（``var/op/value``），是状态变化的唯一来源。
- :class:`SceneBeat`：一个情节 beat（旁白/独白/对话/选择点），可携带若干 effects。
- :class:`SceneEdge`：beat 之间的有向边，可带解锁条件（复用事件层的 :class:`StateCondition`）。
- :class:`SceneGraph`：某事件（``event_id``）内部的情节图（beats + edges）。

场景图**不重复声明状态变量**——变量在事件层（``events.json`` 的 ``state_variables``）
全局声明、两层共享。effect / condition 引用的变量合法性由
:func:`validate_scene_graph_structure` 结合事件层的变量声明校验（见 DESIGN §4.2(h)）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from narrative_forge.core.models.event_graph import (
    StateCondition,
    StateVariable,
    check_state_condition,
)
from narrative_forge.core.models.graph_utils import (
    has_cycle,
    reachable_ignoring_conditions,
)

# 情节 beat 的类型：旁白 / 内心独白 / 对话 / 选择点。
BeatKind = Literal["narration", "monologue", "dialogue", "choice"]

# effect 的写入方式：set=赋值（通用，首选跳档到里程碑）；add=数值增减（仅 scalar）。
EffectOp = Literal["set", "add"]


class Effect(BaseModel):
    """一次状态写入（情节 beat 对全局状态变量的改写，状态变化的唯一来源）。

    Attributes:
        var: 被写入的 :class:`StateVariable` 的 ``id``（须在事件层已声明）。
        op: 写入方式——``set`` 赋值（flag/enum/scalar 通用，首选）；``add`` 数值增减（仅 scalar）。
        value: 写入值（``set``：flag→bool / enum→allowed 标签 / scalar→数值；``add``：数值增量，可负）。
            合法性依赖变量类型，交由 :func:`validate_scene_graph_structure` 结合变量声明校验。
    """

    model_config = ConfigDict(extra="forbid")

    var: str
    op: EffectOp = "set"
    value: Any = None


class SceneBeat(BaseModel):
    """一个情节 beat（场景图的节点）。

    内容与发言人**分离**：``dialogue`` 的 ``content`` 只放纯台词、``monologue`` 只放纯独白
    内容（都不含"某某说："前缀、不夹旁白），发言/独白角色写在 :attr:`speaker`；前端未来
    按 ``speaker + content`` 渲染为"谁说：内容"。``narration``/``choice`` 的 ``speaker`` 留空。

    Attributes:
        id: 稳定标识，供边的 ``source``/``target`` 引用。
        kind: beat 类型（``narration`` 旁白 / ``monologue`` 内心独白 / ``dialogue`` 对话 / ``choice`` 选择点）。
        speaker: 发言人硬引用：仅 ``dialogue``/``monologue`` 使用，且必须是六类世界设定卡片中
            全局唯一的卡片 ``id``；``narration``/``choice`` 留空。界面存 id、显示卡片名称；
            仅角色卡片有立绘。未知、歧义或自由名称由 :func:`validate_scene_graph_structure` 拒绝。
        content: **纯内容**（对话=纯台词、独白=纯独白、旁白=旁白文字、选择=引导语），不含说话人前缀。
        location: beat 所处**地点**——**必填**且**必须引用世界设定 ``locations`` 分类里已存在的
            地点卡片 ``id``（硬引用，见 DESIGN §5.8(b)）。供试玩体验层以该地点卡片的配图作背景。
            Pydantic 层给默认空串仅为兼容旧数据解析；"必填 + 引用合法" 由
            :func:`validate_scene_graph_structure` 结合世界地点集合做结构校验。
        effects: 该 beat 触发的状态写入（唯一写状态处；无写入给 ``[]``）。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    kind: BeatKind = "narration"
    speaker: str = ""
    content: str = ""
    location: str = ""
    effects: list[Effect] = Field(default_factory=list)


class SceneEdge(BaseModel):
    """情节 beat 之间的有向边。

    语义同事件层通用图原语：出度>1 表示玩家在此处做选择（``label`` 为选项文案）；
    ``condition`` 为解锁门槛（引用已声明的状态变量）。

    Attributes:
        id: 稳定标识。
        source: 起点 beat ``id``。
        target: 终点 beat ``id``。
        condition: 可选解锁条件（引用已声明的状态变量）。
        label: 出度>1 时呈现给玩家的选项文案。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    source: str
    target: str
    condition: StateCondition | None = None
    label: str = ""


class SceneGraph(BaseModel):
    """某个事件内部的场景/情节图。

    Attributes:
        event_id: 所属事件（``events.json`` 中某事件节点）的 ``id``。
        beats: 情节 beat 列表。
        edges: beat 之间的有向边列表。
    """

    model_config = ConfigDict(extra="forbid")

    event_id: str
    beats: list[SceneBeat] = Field(default_factory=list)
    edges: list[SceneEdge] = Field(default_factory=list)


def _check_effect(
    beat_id: str, eff: Effect, var_by_id: dict[str, StateVariable]
) -> list[str]:
    """校验一条 effect：变量已声明、``op`` 与变量类型匹配、``value`` 合法。"""
    errors: list[str] = []
    var = var_by_id.get(eff.var)
    if var is None:
        errors.append(f"beat {beat_id} 的 effect 引用了未声明的状态变量：{eff.var}")
        return errors

    if eff.op == "add":
        # add 仅用于 scalar 的数值增减。
        if var.type != "scalar":
            errors.append(f"beat {beat_id} 的 effect：op=add 仅适用于 scalar 变量，{eff.var} 是 {var.type}")
        elif isinstance(eff.value, bool) or not isinstance(eff.value, int):
            errors.append(f"beat {beat_id} 的 effect：scalar 变量 {eff.var} 的 add 增量必须是整数")
        return errors

    # op == "set"：赋值，value 须与变量类型/取值域自洽。
    if var.type == "flag":
        if not isinstance(eff.value, bool):
            errors.append(f"beat {beat_id} 的 effect：flag 变量 {eff.var} 的 set 值必须是布尔")
    elif var.type == "enum":
        if eff.value not in var.allowed:
            errors.append(
                f"beat {beat_id} 的 effect：enum 变量 {eff.var} 的 set 值需取自 allowed：{var.allowed}"
            )
    else:  # scalar
        if isinstance(eff.value, bool) or not isinstance(eff.value, int):
            errors.append(f"beat {beat_id} 的 effect：scalar 变量 {eff.var} 的 set 值必须是整数")
        else:
            if var.min is not None and eff.value < var.min:
                errors.append(f"beat {beat_id} 的 effect：scalar 变量 {eff.var} 的 set 值小于 min={var.min}")
            if var.max is not None and eff.value > var.max:
                errors.append(f"beat {beat_id} 的 effect：scalar 变量 {eff.var} 的 set 值大于 max={var.max}")
    return errors


def validate_scene_graph_structure(
    graph: SceneGraph,
    state_variables: list[StateVariable],
    world_location_ids: set[str] | None = None,
    world_card_ids: set[str] | None = None,
    ambiguous_card_ids: set[str] | None = None,
) -> list[str]:
    """对某事件的场景图做图级**结构性校验** + **effect/condition 引用校验**（阶段 4 硬校验）。

    覆盖 DESIGN §4.2(h) 阶段 4 的硬校验项：beat/边结构合法、前向 DAG 无环、**恰好一个入口
    beat（入度=0，单起点，见 §4.2(c)/§4.5）**、至少一个终止 beat 且忽略条件时可达、effect 与
    边 condition 引用的变量在事件层已声明且取值合法。
    另含 DESIGN §5.8(b) 的 **beat 地点硬引用**：每个 beat 的 ``location`` 必填、且须引用
    世界设定 ``locations`` 里已存在的地点卡片 id。
    另含 DESIGN §4.5 的 **speaker 硬引用**：``dialogue``/``monologue`` 必须引用六类卡片中
    全局唯一的 id；``narration``/``choice`` 必须留空。
    **不做**创作期数值门槛快速提示或完整联合状态传播（分别见 DESIGN §4.2.1、§4.8）。

    Args:
        graph: 已通过 Pydantic 校验的场景图。
        state_variables: 事件层声明的全局状态变量（供 effect/condition 引用校验）。
        world_location_ids: 世界设定 ``locations`` 分类里的地点卡片 id 集合（供 beat.location
            硬引用校验）。为 ``None`` 时表示"世界地点集合未提供"——此时仍强制 ``location`` 非空，
            但**跳过**"是否存在于世界设定"的成员校验（供不关心地点的历史调用方/测试降级使用）。
        world_card_ids: 六类设定中全局唯一的卡片 id 集合（供 beat.speaker 硬引用校验）。
            为 ``None`` 时仍检查对话/独白必须有 speaker、旁白/选择点必须为空，但跳过成员校验。
        ambiguous_card_ids: 跨分类重复的卡片 id。命中时给出无法唯一确定的错误。

    Returns:
        错误说明列表；为空表示结构合法。
    """
    errors: list[str] = []

    var_by_id = {v.id: v for v in state_variables if v.id}
    speech_kinds = {"dialogue", "monologue"}
    ambiguous = ambiguous_card_ids or set()

    # ── beat：id 唯一、非空 ───────────────────────────────────────────────────
    beat_ids: list[str] = []
    seen_beats: set[str] = set()
    for b in graph.beats:
        if not b.id:
            errors.append("存在 id 为空的情节 beat")
            continue
        if b.id in seen_beats:
            errors.append(f"情节 beat id 重复：{b.id}")
        seen_beats.add(b.id)
        beat_ids.append(b.id)
        for eff in b.effects:
            errors.extend(_check_effect(b.id, eff, var_by_id))
        # beat 地点硬引用（DESIGN §5.8(b)）：必填 + 须引用世界设定已存在的地点卡片 id。
        if not b.location:
            errors.append(
                f"beat {b.id} 缺少地点 location（必须引用世界设定 locations 里已存在的地点卡片 id）"
            )
        elif world_location_ids is not None and b.location not in world_location_ids:
            errors.append(
                f"beat {b.id} 的 location 引用了世界设定中不存在的地点：{b.location}"
                "（请从世界设定的 locations 里选一个已有地点，或先到世界设定补该地点再重生成）"
            )
        speaker = (b.speaker or "").strip()
        if b.kind in speech_kinds:
            if not speaker:
                errors.append(
                    f"beat {b.id} 缺少发言人 speaker（dialogue/monologue 必须引用已有设定卡片 id）"
                )
            elif speaker in ambiguous:
                errors.append(
                    f"beat {b.id} 的 speaker「{speaker}」同时出现在多个设定分类，无法唯一确定"
                )
            elif world_card_ids is not None and speaker not in world_card_ids:
                errors.append(
                    f"beat {b.id} 的 speaker 必须是世界设定中已有卡片的唯一 id，当前值是「{speaker}」"
                )
        elif speaker:
            errors.append(
                f"beat {b.id} 是 {b.kind}，speaker 必须留空（只有 dialogue/monologue 可以发言）"
            )

    if not beat_ids:
        errors.append("场景图至少需要一个情节 beat")

    # ── 边：id 唯一、端点存在、无自环、条件引用合法 ──────────────────────────
    seen_edges: set[str] = set()
    for e in graph.edges:
        tag = e.id or f"{e.source}->{e.target}"
        if e.id:
            if e.id in seen_edges:
                errors.append(f"边 id 重复：{e.id}")
            seen_edges.add(e.id)
        if e.source not in seen_beats:
            errors.append(f"边 {tag} 的 source 不存在：{e.source}")
        if e.target not in seen_beats:
            errors.append(f"边 {tag} 的 target 不存在：{e.target}")
        if e.source and e.source == e.target:
            errors.append(f"边 {tag} 不允许自环（source==target）")
        if e.condition is not None:
            errors.extend(check_state_condition(tag, e.condition, var_by_id))

    # ── 前向 DAG：无环（时间不可逆）──────────────────────────────────────────
    if beat_ids and has_cycle(beat_ids, graph.edges):
        errors.append("情节图存在环；场景层应为前向 DAG（时间不可逆）")

    # ── 恰好一个入口 beat（入度=0）：情节图必须单起点（DESIGN §4.2(c)/§4.5）──────
    # 运行时按"首个入度为 0 的 beat"进入；多入口会让其余入口成为永不可达的孤岛情节。
    # 入度按"两端点均为合法 beat"的边计（与下方出度口径一致）。入度全非 0（entries 为空）
    # 意味着有环，已由上面的无环校验覆盖，这里不重复报。
    if beat_ids:
        in_deg: dict[str, int] = {bid: 0 for bid in beat_ids}
        for e in graph.edges:
            if e.source in seen_beats and e.target in seen_beats:
                in_deg[e.target] += 1
        entries = [bid for bid in beat_ids if in_deg[bid] == 0]
        if len(entries) > 1:
            errors.append(
                "情节图有多个入口 beat（入度为 0）：" + "、".join(entries)
                + "；每张情节图必须恰好一个开头 beat（其余 beat 都要有入边），"
                "否则运行时只会进入第一个、其余成为永不可达的孤岛情节"
            )

    # ── 至少一个"终止 beat"（出度=0）且忽略条件时从入口可达（结构断链检测）──────
    if beat_ids:
        out_deg: dict[str, int] = {bid: 0 for bid in beat_ids}
        for e in graph.edges:
            if e.source in seen_beats and e.target in seen_beats:
                out_deg[e.source] += 1
        terminals = [bid for bid in beat_ids if out_deg[bid] == 0]
        if not terminals:
            errors.append("场景图没有终止 beat（出度为 0 的收尾情节）；情节需能走到结束")
        else:
            reachable = reachable_ignoring_conditions(beat_ids, graph.edges)
            if not any(t in reachable for t in terminals):
                errors.append(
                    "没有任何终止 beat 从入口可达（仅按边连通性判定、忽略解锁条件）；"
                    "请检查情节边是否把开头与结尾连起来"
                )

    return errors
