"""有限联合状态的紧凑、无截断前向传播原型。

本模块用于验证 DESIGN §4.6 的三项精确优化：

1. 把 flag、enum 和双侧有界整数 scalar 无损编码进一个 Python 整数；
2. 按执行位置只保留仍会影响未来 condition 的变量位；
3. 按展开后 DAG 的拓扑顺序传播，位置处理完立即释放其状态集合。

原型不设置状态数或时间上限，也不承担当前产品正式结论。它先与遗留字典传播器做小图等价测试，再用于
验证真实项目能否在内存限制内完整结束。
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Callable, Literal

from narrative_forge.core.models.event_graph import (
    EventEdge,
    EventGraph,
    StateCondition,
    StateVariable,
)
from narrative_forge.core.models.runtime import find_entry, init_vars
from narrative_forge.core.models.scene_graph import Effect, SceneEdge, SceneGraph

PositionKind = Literal["EV", "BT", "ADV"]
ProgressCallback = Callable[[dict[str, Any]], None]
CancelCheck = Callable[[], None]
_SAMPLE_LIMIT = 20


class CompactModelError(ValueError):
    """输入状态模型不能被当前有限整数编码精确表达。"""


@dataclass(frozen=True)
class Position:
    """展开后执行图中的一个位置。

    Attributes:
        kind: ``EV`` 进入事件、``BT`` 进入 beat、``ADV`` 情节结束后的事件选择层。
        event_id: 所属事件 id。
        beat_id: ``BT`` 位置的 beat id，其余位置为 ``None``。
    """

    kind: PositionKind
    event_id: str
    beat_id: str | None = None


@dataclass(frozen=True)
class Transition:
    """执行位置之间的一条转移。

    Attributes:
        target: 目标位置索引。
        condition: 在源位置 effects 执行后判断的条件。
        edge_tag: 正式事件/scene 边的稳定标识；内部层间转移为 ``None``。
    """

    target: int
    condition: StateCondition | None
    edge_tag: str | None


@dataclass(frozen=True)
class VariableSlot:
    """一个变量在全局位编码中的固定槽位。

    Attributes:
        declaration: 原始变量声明。
        shift: 该变量最低位在联合整数中的偏移。
        width: 编码宽度。
        domain_size: 变量声明中的真实离散取值数量。
        value_mask: 未移位的取值掩码。
        shifted_mask: 已移动到槽位后的掩码。
        enum_to_code: enum 标签到整数的映射；其它类型为空。
    """

    declaration: StateVariable
    shift: int
    width: int
    domain_size: int
    value_mask: int
    shifted_mask: int
    enum_to_code: dict[str, int]


@dataclass
class ExpandedGraph:
    """事件层和情节层展开得到的统一前向 DAG。

    Attributes:
        positions: 位置索引到结构化位置。
        outgoing: 每个位置的转移列表。
        effects: 进入位置后执行的 effects，仅 ``BT`` 可能非空。
        topological_order: 全部位置的稳定拓扑顺序。
        entry_index: 全局入口事件的 ``EV`` 位置索引。
        graph_out_degree: 源数据中正式出边数量，用于识别真实死路。
        scene_by_event: 事件 id 到 scene。
    """

    positions: list[Position]
    outgoing: list[list[Transition]]
    effects: list[list[Effect]]
    topological_order: list[int]
    entry_index: int
    graph_out_degree: list[int]
    scene_by_event: dict[str, SceneGraph]


class PackedStateCodec:
    """把有限状态变量无损打包到一个整数，并直接在位槽上执行运行语义。"""

    def __init__(
        self,
        state_variables: list[StateVariable],
        *,
        ignored_variable_ids: set[str] | None = None,
    ) -> None:
        """建立稳定变量槽位。

        Args:
            state_variables: 需要进入正式状态键的变量声明。
            ignored_variable_ids: 已声明但只作展示、不参与 condition 的变量 id。

        Raises:
            CompactModelError: scalar 不是双侧有界整数域，或变量声明无法编码。
        """
        self.state_variables = list(state_variables)
        self.ignored_variable_ids = ignored_variable_ids or set()
        self.slots: dict[str, VariableSlot] = {}
        shift = 0
        for declaration in self.state_variables:
            domain_size, enum_to_code = self._domain(declaration)
            width = max(1, (domain_size - 1).bit_length())
            value_mask = (1 << width) - 1
            slot = VariableSlot(
                declaration=declaration,
                shift=shift,
                width=width,
                domain_size=domain_size,
                value_mask=value_mask,
                shifted_mask=value_mask << shift,
                enum_to_code=enum_to_code,
            )
            self.slots[declaration.id] = slot
            shift += width
        self.total_bits = shift
        self.full_mask = (1 << shift) - 1 if shift else 0

    @staticmethod
    def _require_integer(value: Any, label: str) -> int:
        """把整数或整数值 float 规范化为 int。

        Args:
            value: 待检查值。
            label: 错误消息中的字段说明。

        Returns:
            精确整数值。

        Raises:
            CompactModelError: 值不是有限整数语义。
        """
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise CompactModelError(f"{label} 必须是整数")
        integer = int(value)
        if value != integer:
            raise CompactModelError(f"{label} 必须是整数，当前为 {value!r}")
        return integer

    def _domain(self, declaration: StateVariable) -> tuple[int, dict[str, int]]:
        """计算变量域大小及 enum 映射。

        Args:
            declaration: 状态变量声明。

        Returns:
            ``(域大小, enum 标签映射)``。
        """
        if declaration.type == "flag":
            return 2, {}
        if declaration.type == "enum":
            if not declaration.allowed:
                raise CompactModelError(f"enum {declaration.id} 缺少 allowed")
            return len(declaration.allowed), {
                value: index for index, value in enumerate(declaration.allowed)
            }
        if declaration.min is None or declaration.max is None:
            raise CompactModelError(
                f"scalar {declaration.id} 必须同时声明 min/max 才能进入紧凑传播"
            )
        minimum = self._require_integer(declaration.min, f"{declaration.id}.min")
        maximum = self._require_integer(declaration.max, f"{declaration.id}.max")
        if maximum < minimum:
            raise CompactModelError(f"scalar {declaration.id} 的 max 小于 min")
        return maximum - minimum + 1, {}

    def variable_mask(self, variable_id: str) -> int:
        """返回变量在联合整数中的已移位掩码。

        Args:
            variable_id: 状态变量 id。

        Returns:
            对应槽位掩码。
        """
        return self.slots[variable_id].shifted_mask

    def mask_for(self, variable_ids: set[str]) -> int:
        """把一组变量转换成联合位掩码。

        Args:
            variable_ids: 需要保留的变量 id。

        Returns:
            各变量槽位掩码的按位或。
        """
        mask = 0
        for variable_id in variable_ids:
            mask |= self.variable_mask(variable_id)
        return mask

    def encode_value(self, variable_id: str, value: Any) -> int:
        """把一个变量值编码为未移位整数。

        Args:
            variable_id: 状态变量 id。
            value: 对应类型的值。

        Returns:
            从 0 开始的域内整数编码。

        Raises:
            CompactModelError: 值不属于声明域。
        """
        slot = self.slots[variable_id]
        declaration = slot.declaration
        if declaration.type == "flag":
            if not isinstance(value, bool):
                raise CompactModelError(f"flag {variable_id} 的值必须是布尔值")
            return int(value)
        if declaration.type == "enum":
            try:
                return slot.enum_to_code[value]
            except (KeyError, TypeError) as exc:
                raise CompactModelError(
                    f"enum {variable_id} 的值 {value!r} 不在 allowed 中"
                ) from exc
        integer = self._require_integer(value, f"scalar {variable_id} 的值")
        minimum = self._require_integer(declaration.min, f"{variable_id}.min")
        maximum = self._require_integer(declaration.max, f"{variable_id}.max")
        if not minimum <= integer <= maximum:
            raise CompactModelError(
                f"scalar {variable_id} 的值 {integer} 超出 [{minimum}, {maximum}]"
            )
        return integer - minimum

    def decode_value(self, variable_id: str, state: int) -> Any:
        """从联合整数读取一个变量的原始值。

        Args:
            variable_id: 状态变量 id。
            state: 打包后的联合状态。

        Returns:
            flag、enum 标签或 scalar 整数。
        """
        slot = self.slots[variable_id]
        code = (state >> slot.shift) & slot.value_mask
        declaration = slot.declaration
        if declaration.type == "flag":
            return bool(code)
        if declaration.type == "enum":
            if code >= len(declaration.allowed):
                raise CompactModelError(
                    f"enum {variable_id} 出现未使用编码 {code}"
                )
            return declaration.allowed[code]
        minimum = self._require_integer(declaration.min, f"{variable_id}.min")
        return minimum + code

    def write_value(self, state: int, variable_id: str, value: Any) -> int:
        """在联合整数中替换一个变量值。

        Args:
            state: 写入前联合状态。
            variable_id: 目标变量 id。
            value: 新值。

        Returns:
            写入后的联合状态。
        """
        slot = self.slots[variable_id]
        code = self.encode_value(variable_id, value)
        return (state & ~slot.shifted_mask) | (code << slot.shift)

    def encode_initial(self) -> int:
        """按共享运行时默认规则编码全局初始状态。"""
        state = 0
        for variable_id, value in init_vars(self.state_variables).items():
            state = self.write_value(state, variable_id, value)
        return state

    def apply_effects(self, state: int, effects: list[Effect]) -> int:
        """在打包状态上按顺序执行 ``set/add`` 与 scalar 边界截断。

        Args:
            state: effects 执行前状态。
            effects: 当前 beat 的有序状态写入。

        Returns:
            effects 执行后的打包状态。
        """
        current = state
        for effect in effects:
            slot = self.slots.get(effect.var)
            if slot is None:
                if effect.var in self.ignored_variable_ids:
                    continue
                raise CompactModelError(f"effect 引用了未声明变量 {effect.var}")
            declaration = slot.declaration
            if effect.op == "add":
                if declaration.type != "scalar":
                    raise CompactModelError(
                        f"只有 scalar 支持 add，当前为 {effect.var}"
                    )
                delta = self._require_integer(
                    effect.value,
                    f"effect {effect.var}.add",
                )
                value = int(self.decode_value(effect.var, current)) + delta
                minimum = self._require_integer(
                    declaration.min,
                    f"{effect.var}.min",
                )
                maximum = self._require_integer(
                    declaration.max,
                    f"{effect.var}.max",
                )
                value = min(max(value, minimum), maximum)
            else:
                value = effect.value
            current = self.write_value(current, effect.var, value)
        return current

    def eval_condition(
        self,
        condition: StateCondition | None,
        state: int,
    ) -> bool:
        """直接在打包状态上执行共享比较语义。

        Args:
            condition: 边条件；``None`` 表示无条件。
            state: effects 执行后的打包状态。

        Returns:
            条件是否满足。
        """
        if condition is None:
            return True
        if condition.var not in self.slots:
            return False
        current = self.decode_value(condition.var, state)
        value = condition.value
        if condition.op == "==":
            return current == value
        if condition.op == "!=":
            return current != value
        try:
            if condition.op == ">":
                return current > value
            if condition.op == ">=":
                return current >= value
            if condition.op == "<":
                return current < value
            if condition.op == "<=":
                return current <= value
        except TypeError:
            return False
        return False

    def decode_selected(self, state: int, variable_ids: set[str]) -> dict[str, Any]:
        """解码报告需要展示的一组变量。

        Args:
            state: 打包联合状态。
            variable_ids: 需要展示的变量 id。

        Returns:
            稳定按变量声明顺序排列的 ``id → 值`` 字典。
        """
        return {
            declaration.id: self.decode_value(declaration.id, state)
            for declaration in self.state_variables
            if declaration.id in variable_ids
        }


def _event_edge_tag(edge: EventEdge) -> str:
    """返回事件边稳定覆盖标识。"""
    return f"E:{edge.id or f'{edge.source}->{edge.target}'}"


def _scene_edge_tag(event_id: str, edge: SceneEdge) -> str:
    """返回带事件命名空间的 scene 边稳定覆盖标识。"""
    return f"S:{event_id}:{edge.id or f'{edge.source}->{edge.target}'}"


def _condition_state_variables(
    graph: EventGraph,
    scenes: list[SceneGraph],
) -> list[StateVariable]:
    """只返回会影响路线条件的变量声明。

    Args:
        graph: 事件图及全局变量声明。
        scenes: 全部情节图。

    Returns:
        至少被一个事件边或 scene 边 condition 引用的变量，保持声明顺序。
    """
    referenced = {
        edge.condition.var
        for edge in graph.edges
        if edge.condition is not None
    }
    for scene in scenes:
        referenced.update(
            edge.condition.var
            for edge in scene.edges
            if edge.condition is not None
        )
    return [
        variable
        for variable in graph.state_variables
        if variable.id in referenced
    ]


def _sorted_domain_values(values: set[Any]) -> list[Any]:
    """稳定排序同一条件变量的实际可达值。

    Args:
        values: 同一变量的有限值集合。

    Returns:
        数值或同类标签按自然顺序排列；异常混合类型退回 ``repr`` 顺序。
    """
    try:
        return sorted(values)
    except TypeError:
        return sorted(values, key=repr)


def _topological_order(outgoing: list[list[Transition]]) -> list[int]:
    """计算展开图的稳定拓扑顺序。

    Args:
        outgoing: 位置邻接表。

    Returns:
        包含全部位置索引的拓扑顺序。

    Raises:
        CompactModelError: 展开图存在环。
    """
    indegree = [0] * len(outgoing)
    for transitions in outgoing:
        for transition in transitions:
            indegree[transition.target] += 1
    ready = deque(index for index, degree in enumerate(indegree) if degree == 0)
    order: list[int] = []
    while ready:
        source = ready.popleft()
        order.append(source)
        for transition in outgoing[source]:
            indegree[transition.target] -= 1
            if indegree[transition.target] == 0:
                ready.append(transition.target)
    if len(order) != len(outgoing):
        raise CompactModelError("事件/情节展开图存在环，无法按拓扑顺序传播")
    return order


def build_expanded_graph(graph: EventGraph, scenes: list[SceneGraph]) -> ExpandedGraph:
    """把事件层和全部情节层展开为一个统一执行 DAG。

    Args:
        graph: 事件图。
        scenes: 已生成的情节图。

    Returns:
        带稳定位置索引、转移、effects 和拓扑顺序的展开图。
    """
    positions: list[Position] = []
    index_by_position: dict[Position, int] = {}

    def _add_position(position: Position) -> int:
        """登记位置并返回稳定索引。"""
        existing = index_by_position.get(position)
        if existing is not None:
            return existing
        index = len(positions)
        positions.append(position)
        index_by_position[position] = index
        return index

    scene_by_event = {scene.event_id: scene for scene in scenes}
    beat_by_event: dict[str, dict[str, Any]] = {}
    for node in graph.nodes:
        _add_position(Position("EV", node.id))
        _add_position(Position("ADV", node.id))
        scene = scene_by_event.get(node.id)
        if scene is not None:
            beat_by_event[node.id] = {beat.id: beat for beat in scene.beats}
            for beat in scene.beats:
                _add_position(Position("BT", node.id, beat.id))

    outgoing: list[list[Transition]] = [[] for _ in positions]
    effects: list[list[Effect]] = [[] for _ in positions]
    graph_out_degree = [0] * len(positions)
    node_by_id = {node.id: node for node in graph.nodes}
    event_out: dict[str, list[EventEdge]] = defaultdict(list)
    for edge in graph.edges:
        event_out[edge.source].append(edge)

    for node in graph.nodes:
        event_id = node.id
        ev_index = index_by_position[Position("EV", event_id)]
        adv_index = index_by_position[Position("ADV", event_id)]
        scene = scene_by_event.get(event_id)
        if scene is not None and scene.beats:
            entry_beat = find_entry([beat.id for beat in scene.beats], scene.edges)
            if entry_beat is not None:
                outgoing[ev_index].append(
                    Transition(
                        target=index_by_position[Position("BT", event_id, entry_beat)],
                        condition=None,
                        edge_tag=None,
                    )
                )

            scene_out: dict[str, list[SceneEdge]] = defaultdict(list)
            for edge in scene.edges:
                scene_out[edge.source].append(edge)
            for beat in scene.beats:
                beat_index = index_by_position[Position("BT", event_id, beat.id)]
                effects[beat_index] = list(beat.effects)
                edges = scene_out.get(beat.id, [])
                graph_out_degree[beat_index] = len(edges)
                if edges:
                    for edge in edges:
                        outgoing[beat_index].append(
                            Transition(
                                target=index_by_position[
                                    Position("BT", event_id, edge.target)
                                ],
                                condition=edge.condition,
                                edge_tag=_scene_edge_tag(event_id, edge),
                            )
                        )
                else:
                    outgoing[beat_index].append(
                        Transition(
                            target=adv_index,
                            condition=None,
                            edge_tag=None,
                        )
                    )

        if node_by_id[event_id].type != "ending":
            edges = event_out.get(event_id, [])
            graph_out_degree[adv_index] = len(edges)
            for edge in edges:
                outgoing[adv_index].append(
                    Transition(
                        target=index_by_position[Position("EV", edge.target)],
                        condition=edge.condition,
                        edge_tag=_event_edge_tag(edge),
                    )
                )

    entry_event = find_entry([node.id for node in graph.nodes], graph.edges)
    if entry_event is None:
        raise CompactModelError("事件图没有入口")
    return ExpandedGraph(
        positions=positions,
        outgoing=outgoing,
        effects=effects,
        topological_order=_topological_order(outgoing),
        entry_index=index_by_position[Position("EV", entry_event)],
        graph_out_degree=graph_out_degree,
        scene_by_event=scene_by_event,
    )


def analyze_liveness(
    expanded: ExpandedGraph,
    codec: PackedStateCodec,
) -> tuple[list[set[str]], list[set[str]], list[int], list[int]]:
    """精确计算每个位置 effects 前后仍需保留的变量。

    条件在源位置 effects 之后执行。反向经过 ``set x`` 时旧 ``x`` 被完全覆盖，可以从输入状态删除；
    反向经过 ``add x`` 时若未来仍需 ``x``，旧值必须继续保留。

    Args:
        expanded: 展开执行图。
        codec: 全局变量编码器。

    Returns:
        ``(live_before, live_after, before_masks, after_masks)``。
    """
    live_before: list[set[str]] = [set() for _ in expanded.positions]
    live_after: list[set[str]] = [set() for _ in expanded.positions]
    for source in reversed(expanded.topological_order):
        needed_after: set[str] = set()
        for transition in expanded.outgoing[source]:
            needed_after.update(live_before[transition.target])
            if transition.condition is not None:
                needed_after.add(transition.condition.var)
        live_after[source] = needed_after

        needed_before = set(needed_after)
        for effect in reversed(expanded.effects[source]):
            if effect.var not in codec.slots:
                # 展示型变量不影响任何 condition，不进入正式联合状态。
                continue
            if effect.op == "set":
                needed_before.discard(effect.var)
            elif effect.var in needed_before:
                needed_before.add(effect.var)
        live_before[source] = needed_before

    return (
        live_before,
        live_after,
        [codec.mask_for(variable_ids) for variable_ids in live_before],
        [codec.mask_for(variable_ids) for variable_ids in live_after],
    )


def restore_route_to_position(
    graph: EventGraph,
    scenes: list[SceneGraph],
    target_position: str,
    *,
    target_after_state: int | None = None,
    cancel_check: CancelCheck | None = None,
) -> dict[str, Any] | None:
    """定向二次传播并还原到问题位置的一条真实路线。

    完整传播不保存全局前驱。本函数仅在报告需要解释某个问题时重新做深度优先传播，并为实际访问的紧凑
    状态保存一个父指针；找到目标后立即停止。

    Args:
        graph: 事件图。
        scenes: 全部情节图。
        target_position: :func:`_position_label` 产生的目标位置。
        target_after_state: 可选的目标 effects 后打包状态；用于精确还原某个死路状态。
        cancel_check: 可选取消检查；应在取消时抛出调用方定义的异常。

    Returns:
        一条真实位置/边序列及目标状态；目标不可达时返回 ``None``。
    """
    condition_variables = _condition_state_variables(graph, scenes)
    codec = PackedStateCodec(
        condition_variables,
        ignored_variable_ids={
            variable.id for variable in graph.state_variables
        } - {variable.id for variable in condition_variables},
    )
    expanded = build_expanded_graph(graph, scenes)
    live_before, live_after, before_masks, after_masks = analyze_liveness(
        expanded,
        codec,
    )
    target_index = next(
        (
            index
            for index, position in enumerate(expanded.positions)
            if _position_label(position) == target_position
        ),
        None,
    )
    if target_index is None:
        raise CompactModelError(f"待还原位置不存在：{target_position}")

    initial_state = codec.encode_initial() & before_masks[expanded.entry_index]
    initial_key = (expanded.entry_index, initial_state)
    stack = [initial_key]
    visited: list[set[int]] = [set() for _ in expanded.positions]
    visited[expanded.entry_index].add(initial_state)
    parents: dict[
        tuple[int, int],
        tuple[tuple[int, int] | None, str | None],
    ] = {initial_key: (None, None)}
    states_examined = 0

    while stack:
        source, packed = stack.pop()
        states_examined += 1
        if cancel_check is not None and states_examined % 10_000 == 0:
            cancel_check()
        current = codec.apply_effects(packed, expanded.effects[source])
        current &= after_masks[source]
        if source == target_index and (
            target_after_state is None or current == target_after_state
        ):
            keys: list[tuple[int, int]] = []
            cursor: tuple[int, int] | None = (source, packed)
            while cursor is not None:
                keys.append(cursor)
                cursor = parents[cursor][0]
            keys.reverse()

            steps = []
            for index, key in enumerate(keys):
                parent_edge = parents[key][1]
                step = {
                    "position": _position_label(expanded.positions[key[0]]),
                }
                if index > 0 and parent_edge is not None:
                    step["via_edge"] = parent_edge
                steps.append(step)
            return {
                "steps": steps,
                "edge_ids": [
                    step["via_edge"]
                    for step in steps
                    if "via_edge" in step
                ],
                "target_position": target_position,
                "target_state": codec.decode_selected(
                    current,
                    live_after[source],
                ),
                "states_examined": states_examined,
            }

        for transition in reversed(expanded.outgoing[source]):
            if not codec.eval_condition(transition.condition, current):
                continue
            target_state = current & before_masks[transition.target]
            if target_state in visited[transition.target]:
                continue
            visited[transition.target].add(target_state)
            child_key = (transition.target, target_state)
            parents[child_key] = ((source, packed), transition.edge_tag)
            stack.append(child_key)
    return None


def propagate_compact_states(
    graph: EventGraph,
    scenes: list[SceneGraph],
    *,
    progress_callback: ProgressCallback | None = None,
    progress_every: int = 100_000,
    cancel_check: CancelCheck | None = None,
) -> dict:
    """无截断传播全部紧凑联合状态并返回诊断报告。

    Args:
        graph: 事件图。
        scenes: 已生成情节图。
        progress_callback: 可选资源/进度回调。
        progress_every: 每处理多少个位置状态发送一次进度。
        cancel_check: 可选取消检查；应在取消时抛出调用方定义的异常。

    Returns:
        节点、边、死路和内存相关状态规模报告。
    """
    if progress_every <= 0:
        raise ValueError("progress_every 必须大于 0")
    if cancel_check is not None:
        cancel_check()
    started = time.perf_counter()
    condition_variables = _condition_state_variables(graph, scenes)
    codec = PackedStateCodec(
        condition_variables,
        ignored_variable_ids={
            variable.id for variable in graph.state_variables
        } - {variable.id for variable in condition_variables},
    )
    expanded = build_expanded_graph(graph, scenes)
    live_before, live_after, before_masks, after_masks = analyze_liveness(
        expanded,
        codec,
    )

    state_sets: list[set[int] | None] = [None] * len(expanded.positions)
    initial = codec.encode_initial() & before_masks[expanded.entry_index]
    state_sets[expanded.entry_index] = {initial}
    active_positions = {expanded.entry_index}
    reached_positions: set[int] = set()
    reached_events: set[str] = set()
    reached_beats: set[tuple[str, str]] = set()
    reached_endings: set[str] = set()
    structural_terminals: set[str] = set()
    blocked_events: set[str] = set()
    used_edges: set[str] = set()
    edge_observed_values: dict[str, set[Any]] = defaultdict(set)
    dead_end_samples: list[dict[str, Any]] = []
    dead_end_counts_by_source: dict[int, int] = defaultdict(int)
    dead_end_samples_by_source: dict[int, list[dict[str, Any]]] = defaultdict(list)
    dead_end_count = 0
    position_state_counts = [0] * len(expanded.positions)
    node_by_id = {node.id: node for node in graph.nodes}

    states_discovered = 1
    states_processed = 0
    frontier_states = 1
    peak_frontier_states = 1
    peak_frontier_positions = 1
    peak_position_states = 1
    peak_position_index = expanded.entry_index
    max_live_variables = max(
        (
            max(len(live_before[index]), len(live_after[index]))
            for index in range(len(expanded.positions))
        ),
        default=0,
    )

    for source in expanded.topological_order:
        states = state_sets[source]
        if not states:
            continue
        reached_positions.add(source)
        position_state_counts[source] = len(states)
        position = expanded.positions[source]
        if position.kind == "EV":
            reached_events.add(position.event_id)
            if not expanded.outgoing[source]:
                blocked_events.add(position.event_id)
        elif position.kind == "BT" and position.beat_id is not None:
            reached_beats.add((position.event_id, position.beat_id))

        dead_states_at_position: set[int] = set()
        for packed in states:
            states_processed += 1
            if cancel_check is not None and states_processed % 10_000 == 0:
                cancel_check()
            current = codec.apply_effects(packed, expanded.effects[source])
            current &= after_masks[source]
            matched = False
            for transition in expanded.outgoing[source]:
                if transition.edge_tag is not None and transition.condition is not None:
                    edge_observed_values[transition.edge_tag].add(
                        codec.decode_value(transition.condition.var, current)
                    )
                if not codec.eval_condition(transition.condition, current):
                    continue
                matched = True
                if transition.edge_tag is not None:
                    used_edges.add(transition.edge_tag)
                target_state = current & before_masks[transition.target]
                target_states = state_sets[transition.target]
                if target_states is None:
                    target_states = set()
                    state_sets[transition.target] = target_states
                    active_positions.add(transition.target)
                    peak_frontier_positions = max(
                        peak_frontier_positions,
                        len(active_positions),
                    )
                previous_size = len(target_states)
                target_states.add(target_state)
                if len(target_states) != previous_size:
                    states_discovered += 1
                    frontier_states += 1
                    peak_frontier_states = max(
                        peak_frontier_states,
                        frontier_states,
                    )
                    if len(target_states) > peak_position_states:
                        peak_position_states = len(target_states)
                        peak_position_index = transition.target

            if (
                expanded.graph_out_degree[source] > 0
                and not matched
                and current not in dead_states_at_position
            ):
                dead_states_at_position.add(current)
                sample = {
                    "event_id": position.event_id,
                    "location": (
                        f"beat:{position.beat_id}"
                        if position.kind == "BT"
                        else "event"
                    ),
                    "position": _position_label(position),
                    "packed_state": current,
                    "state": codec.decode_selected(
                        current,
                        live_after[source],
                    ),
                    "unmet_conditions": [
                        transition.condition.model_dump()
                        for transition in expanded.outgoing[source]
                        if transition.condition is not None
                    ],
                }
                if len(dead_end_samples) < _SAMPLE_LIMIT:
                    dead_end_samples.append(sample)
                if len(dead_end_samples_by_source[source]) < 3:
                    dead_end_samples_by_source[source].append(sample)

            if position.kind == "ADV":
                node = node_by_id[position.event_id]
                if node.type == "ending":
                    reached_endings.add(position.event_id)
                elif expanded.graph_out_degree[source] == 0:
                    structural_terminals.add(position.event_id)

            if (
                progress_callback is not None
                and states_processed % progress_every == 0
            ):
                if cancel_check is not None:
                    cancel_check()
                progress_callback(
                    {
                        "configs_explored": states_processed,
                        "configs_discovered": states_discovered,
                        "queue_size": frontier_states,
                        "frontier_states": frontier_states,
                        "positions_reached": len(reached_positions),
                        "peak_states_at_position": peak_position_states,
                        "peak_frontier_states": peak_frontier_states,
                        "active_positions": len(active_positions),
                        "condition_variable_count": len(condition_variables),
                        "max_live_variables": max_live_variables,
                        "peak_position": _position_label(
                            expanded.positions[peak_position_index]
                        ),
                        "elapsed_ms": round(
                            (time.perf_counter() - started) * 1000,
                            2,
                        ),
                        "complete": False,
                    }
                )

        dead_end_counts_by_source[source] = len(dead_states_at_position)
        dead_end_count += len(dead_states_at_position)
        frontier_states -= len(states)
        state_sets[source] = None
        active_positions.discard(source)

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    if cancel_check is not None:
        cancel_check()
    if progress_callback is not None:
        progress_callback(
            {
                "configs_explored": states_processed,
                "configs_discovered": states_discovered,
                "queue_size": 0,
                "frontier_states": 0,
                "positions_reached": len(reached_positions),
                "peak_states_at_position": peak_position_states,
                "peak_frontier_states": peak_frontier_states,
                "active_positions": 0,
                "condition_variable_count": len(condition_variables),
                "max_live_variables": max_live_variables,
                "peak_position": _position_label(
                    expanded.positions[peak_position_index]
                ),
                "elapsed_ms": elapsed_ms,
                "complete": True,
            }
        )

    unreachable_events = [
        {
            "id": event_id,
            "title": node_by_id[event_id].title or event_id,
            "type": node_by_id[event_id].type,
        }
        for event_id in node_by_id
        if event_id not in reached_events
    ]
    unreachable_beats = []
    for scene in scenes:
        missed = [
            beat.id
            for beat in scene.beats
            if (scene.event_id, beat.id) not in reached_beats
        ]
        if missed:
            unreachable_beats.append(
                {"event_id": scene.event_id, "beat_ids": missed}
            )

    all_edge_tags = {
        *(_event_edge_tag(edge) for edge in graph.edges),
        *(
            _scene_edge_tag(scene.event_id, edge)
            for scene in scenes
            for edge in scene.edges
        ),
    }
    conditioned_edge_tags = {
        *(
            _event_edge_tag(edge)
            for edge in graph.edges
            if edge.condition is not None
        ),
        *(
            _scene_edge_tag(scene.event_id, edge)
            for scene in scenes
            for edge in scene.edges
            if edge.condition is not None
        ),
    }
    satisfied_conditioned = used_edges & conditioned_edge_tags
    ending_ids = {node.id for node in graph.nodes if node.type == "ending"}
    conditioned_total = len(conditioned_edge_tags)
    edge_diagnostics = []
    for source, transitions in enumerate(expanded.outgoing):
        source_position = expanded.positions[source]
        for transition in transitions:
            if transition.edge_tag is None:
                continue
            target_position = expanded.positions[transition.target]
            edge_diagnostics.append(
                {
                    "edge_tag": transition.edge_tag,
                    "kind": (
                        "event_edge"
                        if transition.edge_tag.startswith("E:")
                        else "scene_edge"
                    ),
                    "edge_id": transition.edge_tag.rsplit(":", 1)[-1],
                    "event_id": source_position.event_id,
                    "source_position": _position_label(source_position),
                    "target_position": _position_label(target_position),
                    "condition": (
                        transition.condition.model_dump()
                        if transition.condition is not None
                        else None
                    ),
                    "source_reached": position_state_counts[source] > 0,
                    "used": transition.edge_tag in used_edges,
                    "observed_values": _sorted_domain_values(
                        edge_observed_values.get(transition.edge_tag, set())
                    ),
                }
            )
    dead_end_groups = [
        {
            "position": _position_label(expanded.positions[source]),
            "event_id": expanded.positions[source].event_id,
            "beat_id": expanded.positions[source].beat_id,
            "count": count,
            "samples": dead_end_samples_by_source[source],
        }
        for source, count in dead_end_counts_by_source.items()
        if count > 0
    ]
    top_positions = sorted(
        (
            {
                "position": _position_label(position),
                "position_kind": position.kind,
                "event_id": position.event_id,
                "beat_id": position.beat_id,
                "states": position_state_counts[index],
                "live_before": len(live_before[index]),
                "live_after": len(live_after[index]),
                "live_before_ids": sorted(live_before[index]),
                "live_after_ids": sorted(live_after[index]),
            }
            for index, position in enumerate(expanded.positions)
            if position_state_counts[index] > 0
        ),
        key=lambda item: item["states"],
        reverse=True,
    )[:20]
    return {
        "summary": {
            "complete": True,
            "ending_coverage": (
                round(len(reached_endings) / len(ending_ids), 4)
                if ending_ids
                else None
            ),
            "endings_reached": len(reached_endings),
            "endings_total": len(ending_ids),
            "has_dead_end": dead_end_count > 0,
            "dead_end_count": dead_end_count,
            "blocked_event_count": len(blocked_events),
            "reachable_event_count": len(reached_events),
            "total_event_count": len(graph.nodes),
            "unreachable_event_count": len(unreachable_events),
            "condition_satisfaction_rate": (
                round(len(satisfied_conditioned) / conditioned_total, 4)
                if conditioned_total
                else None
            ),
        },
        "endings": {
            "reached": sorted(reached_endings),
            "unreached": sorted(ending_ids - reached_endings),
            "structural_terminals": sorted(structural_terminals),
        },
        "dead_ends": {
            "count": dead_end_count,
            "samples": dead_end_samples,
            "groups": dead_end_groups,
        },
        "blocked": {
            "count": len(blocked_events),
            "events": sorted(blocked_events),
        },
        "unreachable_nodes": {
            "events": unreachable_events,
            "beats": unreachable_beats,
        },
        "condition_satisfaction": {
            "total_conditioned_edges": conditioned_total,
            "satisfied": len(satisfied_conditioned),
            "rate": (
                round(len(satisfied_conditioned) / conditioned_total, 4)
                if conditioned_total
                else None
            ),
            "never_satisfied_edges": sorted(
                conditioned_edge_tags - satisfied_conditioned
            ),
        },
        "edge_coverage": {
            "total": len(all_edge_tags),
            "used": len(used_edges),
            "never_used": sorted(all_edge_tags - used_edges),
            "diagnostics": edge_diagnostics,
        },
        "state_space": {
            "states_processed": states_processed,
            "states_discovered": states_discovered,
            "peak_frontier_states": peak_frontier_states,
            "peak_frontier_positions": peak_frontier_positions,
            "peak_position_states": peak_position_states,
            "top_positions": top_positions,
            "condition_variables": [
                {
                    "id": variable.id,
                    "name": variable.name,
                    "type": variable.type,
                    "value_descriptions": variable.value_descriptions,
                    "domain_size": codec.slots[variable.id].domain_size,
                    "bits": codec.slots[variable.id].width,
                }
                for variable in condition_variables
            ],
        },
        "meta": {
            "mode": "compact_exhaustive",
            "complete": True,
            "configs_explored": states_processed,
            "configs_discovered": states_discovered,
            "positions_reached": len(reached_positions),
            "positions_total": len(expanded.positions),
            "peak_queue_size": peak_frontier_states,
            "peak_states_at_position": peak_position_states,
            "packed_bits": codec.total_bits,
            "max_live_before_vars": max(
                (len(values) for values in live_before),
                default=0,
            ),
            "max_live_after_vars": max(
                (len(values) for values in live_after),
                default=0,
            ),
            "elapsed_ms": elapsed_ms,
            "event_nodes": len(graph.nodes),
            "generated_scenes": len(scenes),
            "total_vars": len(graph.state_variables),
        },
    }


def _position_label(position: Position) -> str:
    """把位置转换成稳定的人读标识。"""
    if position.kind == "BT":
        return f"BT:{position.event_id}:{position.beat_id}"
    return f"{position.kind}:{position.event_id}"
