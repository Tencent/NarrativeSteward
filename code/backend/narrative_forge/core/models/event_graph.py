"""事件图（Event Graph）数据模型 —— 四阶段流水线的"事件生成"阶段产出。

对应 DESIGN §4.2「图 + 状态变量」叙事模型的**事件层（阶段 3）**。事件图是
"网状的细化大纲"：把弱格式大纲细化成带因果/时间关联的事件网络，**本身不写状态、
不独立试玩**（状态写入是场景层阶段 4 的职责），要等场景图生成后才能真正游玩。

结构（均以 ``extra="forbid"`` 严格限定字段，避免 Agent 自由发挥导致前端无法渲染）：

- :class:`StateVariable`：全局状态变量声明（类型化：flag/enum/scalar），在事件层声明、
  两层全局共享，作为边条件（以及后续场景层 effect）引用的命名空间。
- :class:`EventNode`：梗概级事件节点（不含 effects）。
- :class:`EventEdge`：事件之间的有向边，可带 :class:`StateCondition` 解锁条件 + 选项文案。
- :class:`EventGraph`：三者汇总。

除 Pydantic 字段校验外，:func:`validate_event_graph_structure` 负责图级**结构性校验**
（引用完整性、前向 DAG 无环、结局可达、条件引用合法等，见 DESIGN §4.2(h)）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from narrative_forge.core.models.graph_utils import (
    has_cycle,
    reachable_ignoring_conditions,
)

# 状态变量类型：flag=布尔；enum=离散标签(带取值域)；scalar=带范围的少量数值。
VarType = Literal["flag", "enum", "scalar"]

# 事件类型：主线 / 可选支线 / 结局。
EventType = Literal["mainline", "optional", "ending"]

# 状态谓词比较运算符。
CondOp = Literal["==", "!=", ">", ">=", "<", "<="]


class StateVariable(BaseModel):
    """一个全局状态变量的声明（在事件层定义，两层共享）。

    基调"标签为主、关键处少量数值"：门槛尽量用 ``flag``/``enum`` 里程碑，``scalar``
    仅用于细腻刻画/排序，尽量不作硬解锁门槛（见 DESIGN §4.2）。

    Attributes:
        id: 稳定标识，供边 ``condition``（及后续场景层 effect）引用。
        name: 显示名（如"与师傅的关系"）。
        type: 变量类型，``flag`` / ``enum`` / ``scalar``。
        allowed: 仅 ``enum`` 使用——离散取值域（如 ``["敌对", "中立", "盟友"]``）。
        min: 仅 ``scalar`` 使用——必填整数下界。
        max: 仅 ``scalar`` 使用——必填整数上界。
        initial: 初始值（可空，空表示用类型默认）；须与 ``type`` 自洽。
        description: 变量含义说明。
        value_descriptions: flag/enum 各运行取值对应的可编辑叙事含义。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    type: VarType
    allowed: list[str] = Field(default_factory=list)
    min: StrictInt | None = None
    max: StrictInt | None = None
    initial: Any = None
    description: str = ""
    value_descriptions: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_coherent(self) -> "StateVariable":
        """校验类型与 ``allowed``/``min``/``max``/``initial`` 的自洽性。"""
        if self.type == "flag":
            if self.allowed:
                raise ValueError("flag 变量不应声明 allowed")
            if self.min is not None or self.max is not None:
                raise ValueError("flag 变量不应声明 min/max")
            if self.initial is not None and not isinstance(self.initial, bool):
                raise ValueError("flag 变量的 initial 必须是布尔值")
            unknown = set(self.value_descriptions) - {"true", "false"}
            if unknown:
                raise ValueError(
                    f"flag 变量的 value_descriptions 只允许 true/false：{sorted(unknown)}"
                )
        elif self.type == "enum":
            if not self.allowed:
                raise ValueError("enum 变量必须声明非空的 allowed 取值域")
            if len(set(self.allowed)) != len(self.allowed):
                raise ValueError("enum 变量的 allowed 取值不能重复")
            if self.min is not None or self.max is not None:
                raise ValueError("enum 变量不应声明 min/max")
            if self.initial is not None and self.initial not in self.allowed:
                raise ValueError(f"enum 变量的 initial 必须取自 allowed：{self.allowed}")
            unknown = set(self.value_descriptions) - set(self.allowed)
            if unknown:
                raise ValueError(
                    "enum 变量的 value_descriptions 包含 allowed 之外的取值："
                    f"{sorted(unknown)}"
                )
        else:  # scalar
            if self.allowed:
                raise ValueError("scalar 变量不应声明 allowed")
            if self.value_descriptions:
                raise ValueError("scalar 变量不应声明 value_descriptions")
            if self.min is None or self.max is None:
                raise ValueError("scalar 变量必须同时声明整数 min/max")
            if self.min > self.max:
                raise ValueError("scalar 变量的 min 不能大于 max")
            if self.initial is not None:
                if isinstance(self.initial, bool) or not isinstance(self.initial, int):
                    raise ValueError("scalar 变量的 initial 必须是整数")
                if self.initial < self.min:
                    raise ValueError("scalar 变量的 initial 小于 min")
                if self.initial > self.max:
                    raise ValueError("scalar 变量的 initial 大于 max")
        return self


class StateCondition(BaseModel):
    """边上的解锁条件：一个针对状态变量的谓词。

    ``value`` 的合法性依赖所引用变量的类型，无法在本地判定，交由
    :func:`validate_event_graph_structure` 结合变量声明校验。

    Attributes:
        var: 所引用的 :class:`StateVariable` 的 ``id``。
        op: 比较运算符（``==`` / ``!=`` / ``>`` / ``>=`` / ``<`` / ``<=``）。
        value: 比较值（flag→bool；enum→allowed 中的标签；scalar→数值）。
    """

    model_config = ConfigDict(extra="forbid")

    var: str
    op: CondOp
    value: Any


class EventNode(BaseModel):
    """一个梗概级事件节点（不写状态）。

    Attributes:
        id: 稳定标识，供边的 ``source``/``target`` 引用。
        title: 事件标题。
        summary: 事件梗概（自由文本）；可用自然语言提示"大致会带来什么后果"，
            作为场景生成的方向指引，但**不是被校验的硬契约**。
        type: ``mainline`` 主线 / ``optional`` 可选 / ``ending`` 结局。
        characters: 参与角色——引用 ``world.json`` 角色卡片 ``id``（仅软校验）。
        locations: 涉及地点——引用 ``world.json`` 地点卡片 ``id``（仅软校验）。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    summary: str = ""
    type: EventType = "mainline"
    characters: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)


class EventEdge(BaseModel):
    """事件之间的有向边。

    出边 = 该事件之后可选的后续事件；入边 = 能到达该事件的路径。出度>1 表示玩家
    在此处做选择（``label`` 为选项文案）；``condition`` 建模长期影响（解锁门槛）。

    Attributes:
        id: 稳定标识。
        source: 起点事件 ``id``。
        target: 终点事件 ``id``。
        condition: 可选解锁条件（引用已声明的状态变量）。
        label: 出度>1 时呈现给玩家的选项文案。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    source: str
    target: str
    condition: StateCondition | None = None
    label: str = ""


class EventGraph(BaseModel):
    """事件图汇总：状态变量、事件节点和事件边。

    Attributes:
        state_variables: 全局状态变量声明（两层共享）。
        nodes: 事件节点列表。
        edges: 事件之间的有向边列表。
    """

    model_config = ConfigDict(extra="forbid")

    state_variables: list[StateVariable] = Field(default_factory=list)
    nodes: list[EventNode] = Field(default_factory=list)
    edges: list[EventEdge] = Field(default_factory=list)


def validate_event_graph_structure(
    graph: EventGraph,
) -> list[str]:
    """对事件图做图级**结构性校验**（Pydantic 字段校验之外的语义约束）。

    覆盖 DESIGN §4.2(h) 阶段 3 的硬校验项；不做"状态流可满足性 / 数值可达性"
    （那是阶段 4 场景层的软校验）。角色/地点对 world 卡片的引用此处不校验
    （需跨片段数据，且按设计仅作 warning）。

    Args:
        graph: 已通过 Pydantic 校验的事件图。

    Returns:
        错误说明列表；为空表示结构合法。
    """
    errors: list[str] = []

    # ── 状态变量：id 唯一、非空 ──────────────────────────────────────────────
    var_by_id: dict[str, StateVariable] = {}
    for v in graph.state_variables:
        if not v.id:
            errors.append("存在 id 为空的状态变量")
            continue
        if v.id in var_by_id:
            errors.append(f"状态变量 id 重复：{v.id}")
        var_by_id[v.id] = v

    # ── 节点：id 唯一、非空 ──────────────────────────────────────────────────
    node_ids: list[str] = []
    seen_nodes: set[str] = set()
    for n in graph.nodes:
        if not n.id:
            errors.append("存在 id 为空的事件节点")
            continue
        if n.id in seen_nodes:
            errors.append(f"事件节点 id 重复：{n.id}")
        seen_nodes.add(n.id)
        node_ids.append(n.id)

    if not node_ids:
        errors.append("事件图至少需要一个事件节点")

    # ── 边：id 唯一、端点存在、无自环、条件引用合法 ──────────────────────────
    seen_edges: set[str] = set()
    for e in graph.edges:
        if e.id:
            if e.id in seen_edges:
                errors.append(f"边 id 重复：{e.id}")
            seen_edges.add(e.id)
        if e.source not in seen_nodes:
            errors.append(f"边 {e.id or f'{e.source}->{e.target}'} 的 source 不存在：{e.source}")
        if e.target not in seen_nodes:
            errors.append(f"边 {e.id or f'{e.source}->{e.target}'} 的 target 不存在：{e.target}")
        if e.source and e.source == e.target:
            errors.append(f"边 {e.id or e.source} 不允许自环（source==target）")
        if e.condition is not None:
            errors.extend(_check_condition(e, e.condition, var_by_id))

    # ── 前向 DAG：无环（时间不可逆）──────────────────────────────────────────
    if node_ids and has_cycle(node_ids, graph.edges):
        errors.append("事件因果图存在环；事件层应为前向 DAG（时间不可逆）")

    # ── 结局：至少一个 ending，且在"忽略条件的纯拓扑连通"下从入口可达 ──────────
    # 仅检查边的连通性（不看 condition），用于捕捉结构断链/孤岛；玩家实战中条件能否
    # 满足属于阶段 4 的软校验，这里不判定。
    endings = [n.id for n in graph.nodes if n.type == "ending"]
    if not endings:
        errors.append("事件图至少需要一个 type=ending 的结局节点")
    elif node_ids:
        reachable = reachable_ignoring_conditions(node_ids, graph.edges)
        if not any(end in reachable for end in endings):
            errors.append(
                "没有任何结局节点从入口可达（仅按边连通性判定、忽略解锁条件）；"
                "请检查边是否把入口与结局连起来"
            )

    return errors


def check_state_condition(
    tag: str, cond: StateCondition, var_by_id: dict[str, StateVariable]
) -> list[str]:
    """校验一条状态谓词（边上的解锁条件）：变量已声明、运算符与取值匹配变量类型。

    事件层与场景层的边**共用同一套条件语义**，故本函数以 ``tag``（用于报错定位的
    边标识）为参数、不绑定具体边类型，供两层复用（见 DESIGN §4.2(0)(e)）。

    Args:
        tag: 报错时定位用的边标识（如边 id 或 ``source->target``）。
        cond: 待校验的状态谓词。
        var_by_id: 已声明状态变量的 ``id → 声明`` 映射。

    Returns:
        错误说明列表；为空表示该条件合法。
    """
    errors: list[str] = []
    var = var_by_id.get(cond.var)
    if var is None:
        errors.append(f"边 {tag} 的条件引用了未声明的状态变量：{cond.var}")
        return errors

    if var.type == "flag":
        if cond.op not in ("==", "!="):
            errors.append(f"边 {tag} 条件：flag 变量 {cond.var} 只能用 == / !=")
        if not isinstance(cond.value, bool):
            errors.append(f"边 {tag} 条件：flag 变量 {cond.var} 的比较值必须是布尔")
    elif var.type == "enum":
        if cond.op not in ("==", "!="):
            errors.append(f"边 {tag} 条件：enum 变量 {cond.var} 只能用 == / !=")
        if cond.value not in var.allowed:
            errors.append(
                f"边 {tag} 条件：enum 变量 {cond.var} 的比较值需取自 allowed：{var.allowed}"
            )
    else:  # scalar
        if isinstance(cond.value, bool) or not isinstance(cond.value, int):
            errors.append(f"边 {tag} 条件：scalar 变量 {cond.var} 的比较值必须是整数")
        else:
            if var.min is not None and cond.value < var.min:
                errors.append(f"边 {tag} 条件：scalar 变量 {cond.var} 的比较值小于 min={var.min}")
            if var.max is not None and cond.value > var.max:
                errors.append(f"边 {tag} 条件：scalar 变量 {cond.var} 的比较值大于 max={var.max}")
    return errors


def _check_condition(
    edge: EventEdge, cond: StateCondition, var_by_id: dict[str, StateVariable]
) -> list[str]:
    """校验单条事件边上的解锁条件（委托给通用的 :func:`check_state_condition`）。"""
    return check_state_condition(edge.id or f"{edge.source}->{edge.target}", cond, var_by_id)
