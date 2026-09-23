"""遗留的局面去重穷举诊断器（见 DESIGN §8.2）。

本模块从入口遍历不同的“位置 + 条件相关状态”局面，统计结局、死路和孤岛等诊断指标。
复杂项目可能达到 ``max_configs`` 上限而截断，因此它只作为小图差分测试参考；正式检测使用
``compact_propagation.py`` 中的无上限紧凑联合状态传播。

**遍历策略：局面去重穷举**——

早期版本"数路线"（对每条多选边组合各走一遍）在选择点多时是指数级、必然截断，无法对
"有没有死路 / 结局是否可达"给确定答案。现改为**按局面去重**：

- **局面（config）= (位置, 投影状态)**。位置 ∈ {进入事件 ``EV``、情节内某 beat ``BT``、
  情节演完回事件层 ``ADV``}；**投影状态 = 只保留"被任何 condition 引用过的变量"的取值**
  （从不被门槛读取的变量对未来的分支/结局/死路完全无关，从去重键剔除）。
- **每个局面只展开一次**（``visited`` 集合去重）：无数条路线走到同一门槛前往往只对应少数
  几种相关状态 → 指数级路线塌成局面数。开销 ≈ 局面数 × 出边数（时间）+ 局面数（内存）。
- **跑完（未触 ``max_configs``）即对存在性问题给确定答案**：有无死路、每个结局可否达、
  哪些事件孤岛、哪条带条件边永不满足——均精确。触上限则标 ``mode=truncated`` /
  ``complete=false``，但**已报出的死路仍是真死路**（发现 sound，只是不保证查全）。
- **天然处理环**：回到同一 (位置, 投影状态) 即被去重跳过；带 ``add`` 的自增环会不断产生新
  局面 → 由 ``max_configs`` 收口。

**语义严格镜像前端 ``code/frontend/src/hooks/usePlaytest.js``**（见 DESIGN §4.3），
镜像的关键规则：

1. 入口 = 入度为 0 的首个节点（``find_entry``）；无则退化为首节点。
2. 变量初值：``initial`` 缺省时 flag→False、enum→allowed[0]、scalar→min??0（``init_vars``）。
3. 进入 beat 即应用其 effects：set 赋值 / add 数值累加（``apply_effects``）；事件节点不写状态。
4. 条件求值 ``== != > >= < <=``（``eval_condition``，语义同 ``check_state_condition``）。
5. 出度语义：出度 0=终止；出度>0 时对每条**条件满足**的出边各展开一个后继局面。
6. 层间过渡：情节走到终止 beat → 回事件层做同样的过滤/选择；进入事件先取其情节图。
7. 结局：``type=ending`` 事件 → 通关；结构终止（出度 0）但未标 ending → 也视为通关闭环。
8. 阻断：进入的事件情节图**尚未生成** → 该局面记为 ``blocked``（区别于 dead_end）。
9. 死路：有出边但**无一条 condition 满足** → ``dead_end``。
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable

from narrative_forge.core.models.event_graph import (
    EventEdge,
    EventGraph,
)
from narrative_forge.core.models.runtime import apply_effects, eval_condition, find_entry, init_vars
from narrative_forge.core.models.scene_graph import SceneEdge, SceneGraph

# 默认防爆上限：不同局面数上限（超出即截断，标 mode=truncated / complete=false）；单局面最大
# 步深（防御性，去重已能挡住普通环，仅防 add 自增环短时暴涨）。当前论文规模远达不到，穷举即精确。
DEFAULT_MAX_CONFIGS = 1_000_000
DEFAULT_MAX_DEPTH = 100_000
# 死路样例最多保留条数（供人读诊断，避免报告过大）。
_SAMPLE_LIMIT = 20

# 基准工具可订阅遍历进度；回调只接收只读统计快照，不参与状态语义。
ProgressCallback = Callable[[dict[str, Any]], None]


def _referenced_vars(graph: EventGraph, scenes: list[SceneGraph]) -> set[str]:
    """收集被任何 condition 引用过的变量 id，作为遗留诊断的状态投影依据。

    只有这些变量的取值会影响未来的分支/结局/死路；其余变量对遍历完全无关，可从局面去重键
    中剔除，从而把指数级路线塌成局面数。
    """
    refs: set[str] = set()
    for e in graph.edges:
        if e.condition is not None:
            refs.add(e.condition.var)
    for s in scenes:
        for e in s.edges:
            if e.condition is not None:
                refs.add(e.condition.var)
    return refs


def _event_edge_tag(e: EventEdge) -> str:
    """事件边的稳定 tag（供门槛满足率统计去重）。"""
    return f"E:{e.id or f'{e.source}->{e.target}'}"


def _scene_edge_tag(event_id: str, e: SceneEdge) -> str:
    """情节边的稳定 tag（带所属事件前缀，跨事件不冲突）。"""
    return f"S:{event_id}:{e.id or f'{e.source}->{e.target}'}"


def _project(vars_: dict[str, Any], ref_vars: tuple[str, ...]) -> tuple:
    """把状态投影到被 condition 引用的变量上，得到可哈希的去重键片段。"""
    return tuple(vars_.get(k) for k in ref_vars)


# ── 遍历用的轻量数据结构 ───────────────────────────────────────────────────
@dataclass
class _Acc:
    """全局统计累加器（跨所有局面共享）。"""

    visited_events: set[str] = field(default_factory=set)
    visited_beats: set[tuple[str, str]] = field(default_factory=set)  # (event_id, beat_id)
    reached_endings: set[str] = field(default_factory=set)  # 抵达的 type=ending 事件 id
    structural_terminals: set[str] = field(default_factory=set)  # 出度 0 但未标 ending 的收尾事件
    satisfied_cond_edges: set[str] = field(default_factory=set)  # 存在可达局面能满足的"带条件"边 tag
    dead_end_keys: set[tuple] = field(default_factory=set)  # 不同死路局面的去重键
    dead_end_samples: list[dict] = field(default_factory=list)
    blocked_events: set[str] = field(default_factory=set)
    blocked_keys: set[tuple] = field(default_factory=set)  # 不同阻断局面的去重键
    shortest_complete_steps: int | None = None  # 抵达任一结局/结构收尾的最短步数（BFS）
    configs_explored: int = 0  # 展开过的不同局面数
    truncated: bool = False


def _describe_dead_end(
    node_title: dict[str, str],
    var_name: dict[str, str],
    ref_vars: tuple[str, ...],
    vars_: dict[str, Any],
    event_id: str,
    location: str,
    out_edges: list,
) -> dict:
    """构造一条死路样例（人读）：在何处卡住、哪些条件够不到、当时相关状态是什么。"""
    gaps = []
    for e in out_edges:
        cond = getattr(e, "condition", None)
        if cond is not None:
            name = var_name.get(cond.var, cond.var)
            gaps.append(f"{name} {cond.op} {cond.value!r}")
    # 卡住时"被门槛引用的变量"的取值，帮助定位是哪种状态组合走进了死路。
    state = {var_name.get(k, k): vars_.get(k) for k in ref_vars}
    return {
        "event_id": event_id,
        "event_title": node_title.get(event_id, event_id),
        "location": location,  # "event" 或 "beat:<beat_id>"
        "unmet_conditions": gaps or ["无满足条件的出边"],
        "state": state,
    }


# ── 验证器主体 ─────────────────────────────────────────────────────────────
def simulate_playability(
    graph: EventGraph,
    scenes: list[SceneGraph],
    *,
    max_configs: int | None = DEFAULT_MAX_CONFIGS,
    max_depth: int | None = DEFAULT_MAX_DEPTH,
    progress_callback: ProgressCallback | None = None,
    progress_every: int = 100_000,
) -> dict:
    """运行遗留的局面去重穷举并产出诊断指标。

    从入口事件出发，用 BFS 遍历所有不同 (位置, 投影状态) 局面（每个只展开一次），累计结局
    覆盖 / 死路 / 阻断 / 孤岛 / 门槛满足率 / 变量触达等指标。局面数达 ``max_configs`` 即截断
    并标 ``mode=truncated`` / ``complete=false``（当前论文规模远达不到，穷举即精确）。

    Args:
        graph: 事件图（状态变量声明 + 事件节点 + 事件边）。
        scenes: 已生成的情节图列表（未生成的事件不在其中 → 进入即记 blocked）。
        max_configs: 不同局面数上限；传 ``None`` 表示不按局面数截断。
        max_depth: 单局面最大步深；传 ``None`` 表示不按深度截断。
        progress_callback: 可选进度回调，供离线基准输出状态增长，不影响遍历结论。
        progress_every: 每展开多少个局面调用一次进度回调。

    Returns:
        指标报告 dict（结构见 :func:`_assemble_report`，可直接 JSON 序列化）。
    """
    if progress_every <= 0:
        raise ValueError("progress_every 必须大于 0")

    started = time.perf_counter()

    node_by_id = {n.id: n for n in graph.nodes}
    node_ids = [n.id for n in graph.nodes]
    node_title = {n.id: (n.title or n.id) for n in graph.nodes}
    var_name = {v.id: (v.name or v.id) for v in graph.state_variables}
    ending_ids = {n.id for n in graph.nodes if n.type == "ending"}

    # 事件层出边索引。
    event_out: dict[str, list[EventEdge]] = defaultdict(list)
    for e in graph.edges:
        event_out[e.source].append(e)

    # 情节层：按事件建 beat 索引 + 出边索引，避免遍历时反复线性扫描。
    scene_by_event: dict[str, SceneGraph] = {s.event_id: s for s in scenes}
    scene_beat_by_id: dict[str, dict] = {}
    scene_out: dict[str, dict[str, list[SceneEdge]]] = {}
    scene_entry: dict[str, str | None] = {}
    for s in scenes:
        scene_beat_by_id[s.event_id] = {b.id: b for b in s.beats}
        outs: dict[str, list[SceneEdge]] = defaultdict(list)
        for e in s.edges:
            outs[e.source].append(e)
        scene_out[s.event_id] = outs
        scene_entry[s.event_id] = find_entry([b.id for b in s.beats], s.edges) if s.beats else None

    # 去重投影依据：被任何 condition 引用的变量（排序成稳定元组，作局面键的一部分）。
    ref_vars = tuple(sorted(_referenced_vars(graph, scenes)))

    # 门槛满足率的分母：全部"带条件"的边（事件边 + 已生成情节边）。
    cond_edge_tags: set[str] = set()
    for e in graph.edges:
        if e.condition is not None:
            cond_edge_tags.add(_event_edge_tag(e))
    for s in scenes:
        for e in s.edges:
            if e.condition is not None:
                cond_edge_tags.add(_scene_edge_tag(s.event_id, e))

    # 变量触达（静态扫描）：哪些变量被任何 effect 写过。
    written_vars: set[str] = set()
    for s in scenes:
        for b in s.beats:
            for eff in b.effects:
                written_vars.add(eff.var)

    acc = _Acc()
    entry = find_entry(node_ids, graph.edges)
    if entry is None:
        return _empty_report(graph, scenes, started, "事件图无节点")

    init = init_vars(graph.state_variables)
    # BFS 队列：元素为 (position, vars, depth)；position 为可哈希元组，见模块级说明的三类。
    # 首帧局面键先入 visited，避免重复入队。
    start_pos = ("EV", entry)
    visited: set[tuple] = {(start_pos, _project(init, ref_vars))}
    queue: deque = deque([(start_pos, init, 0)])
    states_per_position: dict[tuple, int] = defaultdict(int)
    states_per_position[start_pos] = 1
    peak_states_at_position = 1
    peak_queue_size = 1

    def _push(next_pos: tuple, next_vars: dict[str, Any], cur_depth: int) -> None:
        """尝试把一个后继局面入队：算去重键，未见过才入队；触上限则标截断。"""
        nonlocal peak_queue_size, peak_states_at_position

        key = (next_pos, _project(next_vars, ref_vars))
        if key in visited:
            return
        if max_configs is not None and len(visited) >= max_configs:
            acc.truncated = True
            return
        visited.add(key)
        queue.append((next_pos, next_vars, cur_depth + 1))
        states_per_position[next_pos] += 1
        peak_states_at_position = max(
            peak_states_at_position,
            states_per_position[next_pos],
        )
        peak_queue_size = max(peak_queue_size, len(queue))

    while queue:
        position, vars_, depth = queue.popleft()
        acc.configs_explored += 1
        kind = position[0]

        if progress_callback is not None and acc.configs_explored % progress_every == 0:
            progress_callback(
                {
                    "configs_explored": acc.configs_explored,
                    "configs_discovered": len(visited),
                    "queue_size": len(queue),
                    "positions_reached": len(states_per_position),
                    "peak_states_at_position": peak_states_at_position,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
                    "complete": False,
                }
            )

        if max_depth is not None and depth > max_depth:
            acc.truncated = True
            continue

        if kind == "EV":
            event_id = position[1]
            if event_id not in node_by_id:
                continue  # 出边指向不存在的节点：由事件图硬校验负责，这里静默跳过
            acc.visited_events.add(event_id)
            scene = scene_by_event.get(event_id)
            entry_beat = scene_entry.get(event_id)
            if scene is None or not scene.beats or entry_beat is None:
                # 情节图未生成（或无有效入口）→ 该局面阻断（区别于死路）。
                acc.blocked_events.add(event_id)
                acc.blocked_keys.add((position, _project(vars_, ref_vars)))
                continue
            _push(("BT", event_id, entry_beat), vars_, depth)

        elif kind == "BT":
            _, event_id, beat_id = position
            beat = scene_beat_by_id[event_id].get(beat_id)
            if beat is None:
                continue
            acc.visited_beats.add((event_id, beat_id))
            nvars = apply_effects(vars_, beat.effects, graph.state_variables)
            outs = scene_out[event_id].get(beat_id, [])
            if not outs:
                # 情节走到终止 beat → 回事件层继续。
                _push(("ADV", event_id), nvars, depth)
                continue
            ok = [e for e in outs if eval_condition(e.condition, nvars)]
            for e in ok:
                if e.condition is not None:
                    acc.satisfied_cond_edges.add(_scene_edge_tag(event_id, e))
            if not ok:
                _record_dead_end(
                    acc, node_title, var_name, ref_vars, nvars, event_id, f"beat:{beat_id}", outs
                )
                continue
            for e in ok:
                _push(("BT", event_id, e.target), nvars, depth)

        else:  # kind == "ADV"：情节演完，在事件层做过滤/选择/结局判定。
            event_id = position[1]
            node = node_by_id[event_id]
            if node.type == "ending":
                acc.reached_endings.add(event_id)
                _record_complete(acc, depth)
                continue
            outs = event_out.get(event_id, [])
            if not outs:
                # 结构上收尾（无出边）但未标 ending：仍视为通关闭环（对齐前端）。
                acc.structural_terminals.add(event_id)
                _record_complete(acc, depth)
                continue
            ok = [e for e in outs if eval_condition(e.condition, vars_)]
            for e in ok:
                if e.condition is not None:
                    acc.satisfied_cond_edges.add(_event_edge_tag(e))
            if not ok:
                _record_dead_end(
                    acc, node_title, var_name, ref_vars, vars_, event_id, "event", outs
                )
                continue
            for e in ok:
                _push(("EV", e.target), vars_, depth)

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    if progress_callback is not None:
        progress_callback(
            {
                "configs_explored": acc.configs_explored,
                "configs_discovered": len(visited),
                "queue_size": 0,
                "positions_reached": len(states_per_position),
                "peak_states_at_position": peak_states_at_position,
                "elapsed_ms": elapsed_ms,
                "complete": not acc.truncated,
            }
        )
    return _assemble_report(
        graph, scenes, acc, ending_ids, cond_edge_tags, written_vars,
        node_by_id, ref_vars, elapsed_ms, max_configs, max_depth,
        len(visited), peak_queue_size, len(states_per_position),
        peak_states_at_position,
    )


def _record_dead_end(
    acc: _Acc,
    node_title: dict[str, str],
    var_name: dict[str, str],
    ref_vars: tuple[str, ...],
    vars_: dict[str, Any],
    event_id: str,
    location: str,
    out_edges: list,
) -> None:
    """登记一个死路局面（按去重键计数，避免同一局面重复；样例限量保留）。"""
    key = (location, event_id, _project(vars_, ref_vars))
    if key in acc.dead_end_keys:
        return
    acc.dead_end_keys.add(key)
    if len(acc.dead_end_samples) < _SAMPLE_LIMIT:
        acc.dead_end_samples.append(
            _describe_dead_end(node_title, var_name, ref_vars, vars_, event_id, location, out_edges)
        )


def _record_complete(acc: _Acc, depth: int) -> None:
    """登记一个通关局面（更新最短通关步数）。"""
    if acc.shortest_complete_steps is None or depth < acc.shortest_complete_steps:
        acc.shortest_complete_steps = depth


def _assemble_report(
    graph: EventGraph,
    scenes: list[SceneGraph],
    acc: _Acc,
    ending_ids: set[str],
    cond_edge_tags: set[str],
    written_vars: set[str],
    node_by_id: dict,
    ref_vars: tuple[str, ...],
    elapsed_ms: float,
    max_configs: int | None,
    max_depth: int | None,
    configs_discovered: int,
    peak_queue_size: int,
    positions_reached: int,
    peak_states_at_position: int,
) -> dict:
    """把累加器整理成可 JSON 序列化的遗留诊断报告（口径为“局面”）。"""
    # 孤岛：真实推演下从未进入的事件 / beat。
    unreachable_events = [
        {"id": nid, "title": node_by_id[nid].title or nid, "type": node_by_id[nid].type}
        for nid in node_by_id
        if nid not in acc.visited_events
    ]
    unreachable_beats = []
    for s in scenes:
        missed = [b.id for b in s.beats if (s.event_id, b.id) not in acc.visited_beats]
        if missed:
            unreachable_beats.append({"event_id": s.event_id, "beat_ids": missed})

    # 门槛满足率：带条件的边中"存在可达局面能满足"的比例；未满足的单列（可疑死分支）。
    satisfied = acc.satisfied_cond_edges & cond_edge_tags
    unsatisfied = sorted(cond_edge_tags - satisfied)
    cond_total = len(cond_edge_tags)
    cond_rate = round(len(satisfied) / cond_total, 4) if cond_total else None

    # 变量触达：声明了却从未被任何 effect 改动过的变量（可能是死设定）。
    untouched_vars = [
        {"id": v.id, "name": v.name or v.id, "type": v.type}
        for v in graph.state_variables
        if v.id not in written_vars
    ]

    ending_total = len(ending_ids)
    ending_reached = len(acc.reached_endings)
    dead_end_count = len(acc.dead_end_keys)
    complete = not acc.truncated
    return {
        "summary": {
            # complete=True 时下列存在性结论精确；False 表示触 MAX_CONFIGS 未完整验证。
            "complete": complete,
            "ending_coverage": round(ending_reached / ending_total, 4) if ending_total else None,
            "endings_reached": ending_reached,
            "endings_total": ending_total,
            "has_dead_end": dead_end_count > 0,
            "dead_end_count": dead_end_count,
            "blocked_event_count": len(acc.blocked_events),
            "reachable_event_count": len(acc.visited_events),
            "total_event_count": len(graph.nodes),
            "unreachable_event_count": len(unreachable_events),
            "condition_satisfaction_rate": cond_rate,
            "untouched_var_count": len(untouched_vars),
        },
        "endings": {
            "reached": sorted(acc.reached_endings),
            "unreached": sorted(ending_ids - acc.reached_endings),
            "structural_terminals": sorted(acc.structural_terminals),
        },
        "dead_ends": {"count": dead_end_count, "samples": acc.dead_end_samples},
        "blocked": {"count": len(acc.blocked_keys), "events": sorted(acc.blocked_events)},
        "unreachable_nodes": {"events": unreachable_events, "beats": unreachable_beats},
        "condition_satisfaction": {
            "total_conditioned_edges": cond_total,
            "satisfied": len(satisfied),
            "rate": cond_rate,
            "never_satisfied_edges": unsatisfied,
        },
        "path_length": {"shortest_complete_steps": acc.shortest_complete_steps},
        "var_coverage": {
            "declared": len(graph.state_variables),
            "touched": len(written_vars),
            "untouched": untouched_vars,
        },
        "meta": {
            "mode": "truncated" if acc.truncated else "exhaustive",
            "complete": complete,
            "configs_explored": acc.configs_explored,
            "configs_discovered": configs_discovered,
            "max_configs": max_configs,
            "max_depth": max_depth,
            "peak_queue_size": peak_queue_size,
            "positions_reached": positions_reached,
            "peak_states_at_position": peak_states_at_position,
            "elapsed_ms": elapsed_ms,
            "event_nodes": len(graph.nodes),
            "generated_scenes": len(scenes),
            "projected_vars": len(ref_vars),
            "total_vars": len(graph.state_variables),
        },
    }


def _empty_report(
    graph: EventGraph, scenes: list[SceneGraph], started: float, note: str
) -> dict:
    """无法遍历（如事件图无节点）时的空报告（携带说明）。"""
    return {
        "summary": {"note": note},
        "meta": {
            "mode": "empty",
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "event_nodes": len(graph.nodes),
            "generated_scenes": len(scenes),
        },
    }
