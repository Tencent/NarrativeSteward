"""跨层数值门槛快速提示（见 DESIGN §4.2.1）。

事件边的解锁条件可能引用 scalar 阈值（如"武力 ≥ 100 才解锁"），而 scalar 只能由
**场景层** beat 的 effects（``set``/``add``）逐步改写。于是存在"到底够不够得到阈值"
的跨层平衡问题：若全程没有任何情节能把某 scalar 抬到门槛，这条边就是死路。

本模块做的是**静态软校验**：不实际游玩，而是把全项目所有场景的 effects 汇总，为每个
scalar 变量估一个"再乐观也不过如此"的**可达上界 / 下界**，再逐条比对引用了 scalar
阈值的事件边。判定基调：

- **全图上界（过估计）→ 零误报**：上界是数学上的过估计（假设你能收集到全图每一笔
  正向增量、并从最高的 set 起步），任何真实路径的可达值都 ≤ 该上界。因此"上界都够不到
  阈值"就意味着**在任何路径上都不可达**，可以放心报 warning；反之绝不误报可达的门槛。
- **warning 级、非阻塞**：可达性问题也可能是**有意的死路**（叙事上刻意封死的分支），
  故只报 warning 喂 Agent / 创作者复核，不作 hard fail、不触发修复循环。
- **对"情节尚未全生成"鲁棒**：只用当前已生成的场景估算；措辞注明"按当前已生成情节估算"。

逐路径累加（更紧的估计）对分文件存储 + 未全生成的场景较脆弱，留作后续迭代。
"""

from __future__ import annotations

from narrative_forge.core.models.event_graph import EventGraph, StateVariable
from narrative_forge.core.models.scene_graph import SceneGraph

# 需要"往上够"的比较运算符（阈值靠可达**上界**判定）。
_UPPER_OPS = (">", ">=")
# 需要"往下够"的比较运算符（阈值靠可达**下界**判定）。
_LOWER_OPS = ("<", "<=")


class _ScalarBounds:
    """某个 scalar 变量在全项目范围内的可达上界 / 下界（保守估计）。

    Attributes:
        upper: 可达**上界**（过估计，真实任何路径的可得值都不超过它）。
        lower: 可达**下界**（欠估计，真实任何路径的可得值都不低于它）。
        touched: 是否有任何场景 effect 写过该变量（用于给"无情节能改动此门槛"更强提示）。
    """

    def __init__(self, upper: float, lower: float, touched: bool) -> None:
        self.upper = upper
        self.lower = lower
        self.touched = touched


def _scalar_start(var: StateVariable) -> float:
    """scalar 变量的起始值：优先 ``initial``，缺省按 ``min ?? 0``（与前端 ``initVars`` 一致）。"""
    if isinstance(var.initial, (int, float)) and not isinstance(var.initial, bool):
        return float(var.initial)
    return float(var.min) if var.min is not None else 0.0


def _clamp(value: float, lo: float | None, hi: float | None) -> float:
    """把 ``value`` 夹到 ``[lo, hi]``（``None`` 表示该侧不设界）。"""
    if hi is not None and value > hi:
        value = float(hi)
    if lo is not None and value < lo:
        value = float(lo)
    return value


def _compute_bounds(
    scalar_vars: dict[str, StateVariable], scenes: list[SceneGraph]
) -> dict[str, _ScalarBounds]:
    """为每个 scalar 变量汇总全项目场景 effects，估其可达上界 / 下界。

    上界：从"起始值与所有 ``set`` 目标值中的最大者"出发，叠加全部**正向** ``add`` 增量；
    下界：从其中的最小者出发，叠加全部**负向** ``add`` 增量；各自再 clamp 到 ``[min, max]``。

    Args:
        scalar_vars: ``id → StateVariable``，仅含 scalar 类型变量。
        scenes: 已解析的场景图列表（只读其 beat effects）。

    Returns:
        ``id → _ScalarBounds``。
    """
    # 各 scalar 的起点候选（含起始值）、正/负增量累加、以及是否被写过。
    bases: dict[str, list[float]] = {vid: [_scalar_start(v)] for vid, v in scalar_vars.items()}
    pos_add: dict[str, float] = {vid: 0.0 for vid in scalar_vars}
    neg_add: dict[str, float] = {vid: 0.0 for vid in scalar_vars}
    touched: dict[str, bool] = {vid: False for vid in scalar_vars}

    for scene in scenes:
        for beat in scene.beats:
            for eff in beat.effects:
                if eff.var not in scalar_vars:
                    continue  # 非 scalar / 未声明变量的合法性由 effect 引用硬校验负责
                if not isinstance(eff.value, (int, float)) or isinstance(eff.value, bool):
                    continue  # 非数值 value 已被引用硬校验拦下，这里跳过不影响估计
                touched[eff.var] = True
                val = float(eff.value)
                if eff.op == "set":
                    bases[eff.var].append(val)  # 可跳到某档，故纳入起点候选
                else:  # add
                    if val > 0:
                        pos_add[eff.var] += val
                    elif val < 0:
                        neg_add[eff.var] += val

    bounds: dict[str, _ScalarBounds] = {}
    for vid, var in scalar_vars.items():
        upper = _clamp(max(bases[vid]) + pos_add[vid], var.min, var.max)
        lower = _clamp(min(bases[vid]) + neg_add[vid], var.min, var.max)
        bounds[vid] = _ScalarBounds(upper=upper, lower=lower, touched=touched[vid])
    return bounds


def check_numeric_reachability(graph: EventGraph, scenes: list[SceneGraph]) -> list[dict]:
    """跨层数值可达性软校验：找出"再乐观也够不到"的 scalar 事件边阈值。

    只针对**事件边**上引用 scalar 变量的解锁条件；enum/flag 门槛靠里程碑显式置位、天然
    可达可校验，不在此列。判定用全图上界/下界做过估计，只在绝对
    不可达时报 warning，不误报。

    Args:
        graph: 事件图（提供状态变量声明与事件边条件）。
        scenes: 已解析的全部场景图（提供 effects，估各 scalar 的可达范围）。

    Returns:
        warning 项列表，每项为 dict：``{"message": 人读中文, "edge_id": 边标识,
        "var": 变量 id}``。``edge_id`` 取 ``edge.id``（无则 ``source->target``），与前端
        图上边 id 约定一致，供图可视化精确标红不可达边（见 DESIGN §5.7）。为空表示未发现。
    """
    scalar_vars = {
        v.id: v for v in graph.state_variables if v.id and v.type == "scalar"
    }
    if not scalar_vars:
        return []

    bounds = _compute_bounds(scalar_vars, scenes)
    node_title = {n.id: (n.title or n.id) for n in graph.nodes}

    warnings: list[dict] = []
    for edge in graph.edges:
        cond = edge.condition
        if cond is None or cond.var not in scalar_vars:
            continue
        if not isinstance(cond.value, (int, float)) or isinstance(cond.value, bool):
            continue  # 非数值阈值由结构/引用硬校验负责
        b = bounds[cond.var]
        var = scalar_vars[cond.var]
        threshold = float(cond.value)

        # 判"绝对不可达"：上/下界都够不到时才报（过估计 → 零误报）。
        unreachable = False
        if cond.op in _UPPER_OPS:
            unreachable = b.upper < threshold or (cond.op == ">" and b.upper <= threshold)
        elif cond.op in _LOWER_OPS:
            unreachable = b.lower > threshold or (cond.op == "<" and b.lower >= threshold)
        elif cond.op == "==":
            unreachable = threshold < b.lower or threshold > b.upper
        # != 几乎总可满足，跳过。

        if not unreachable:
            continue

        edge_tag = edge.id or f"{edge.source}->{edge.target}"
        path = f"{node_title.get(edge.source, edge.source)} → {node_title.get(edge.target, edge.target)}"
        reach_hint = (
            "当前没有任何情节 effect 改动过该变量"
            if not b.touched
            else f"按当前已生成情节估算，可得范围约 [{_fmt(b.lower)}, {_fmt(b.upper)}]"
        )
        message = (
            f"事件边「{path}」(边 {edge_tag}) 要求 {var.name or cond.var} {cond.op} "
            f"{_fmt(threshold)}，但{reach_hint}，该门槛很可能不可达（请复核阈值/情节 effect，"
            "或确认这是有意封死的分支）。"
        )
        warnings.append({"message": message, "edge_id": edge_tag, "var": cond.var})
    return warnings


def _fmt(value: float) -> str:
    """数值展示：整数去掉小数尾巴（``5.0`` → ``5``）。"""
    return str(int(value)) if float(value).is_integer() else str(value)
