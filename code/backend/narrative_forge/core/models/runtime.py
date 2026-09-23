"""互动叙事运行时的公共纯函数。

前端试玩、旧差分参考和正式联合状态检测器都必须遵守同一套状态语义。本模块集中后端实现，避免不同检测器
各自解释条件和 effects。前端 ``usePlaytest.js`` 保持镜像，并由共享 fixture 测试保证行为一致。
"""

from __future__ import annotations

from typing import Any, Protocol

from narrative_forge.core.models.event_graph import StateCondition, StateVariable
from narrative_forge.core.models.scene_graph import Effect


class _DirectedEdge(Protocol):
    """``find_entry`` 所需的最小边接口。"""

    target: str


def init_vars(state_variables: list[StateVariable]) -> dict[str, Any]:
    """按变量声明构造初始状态。

    Args:
        state_variables: 事件图声明的全局状态变量。

    Returns:
        ``变量 id → 初始值``。缺省值规则与前端试玩一致：flag=False、enum=allowed 首项、
        scalar=min（未声明 min 时为 0）。
    """
    vars_: dict[str, Any] = {}
    for var in state_variables:
        if var.initial is not None:
            vars_[var.id] = var.initial
        elif var.type == "flag":
            vars_[var.id] = False
        elif var.type == "enum":
            vars_[var.id] = var.allowed[0] if var.allowed else ""
        else:
            vars_[var.id] = var.min if var.min is not None else 0
    return vars_


def eval_condition(condition: StateCondition | None, vars_: dict[str, Any]) -> bool:
    """判断一条边条件在当前状态下是否满足。

    ``None`` 表示无条件边。类型不可比较或变量缺失时返回 ``False``，不让一次坏数据中断诊断。
    """
    if condition is None:
        return True
    current = vars_.get(condition.var)
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


def apply_effects(
    vars_: dict[str, Any],
    effects: list[Effect],
    state_variables: list[StateVariable] | None = None,
) -> dict[str, Any]:
    """应用一个 beat 的状态写入并返回新字典。

    ``set`` 直接赋值；``add`` 在当前数值上累加。scalar 声明的 ``min/max`` 是运行时合法域，
    每次写入后按已声明的单侧或双侧边界截断。调用方未提供变量声明时保留旧兼容行为。

    Args:
        vars_: 写入前的全局状态。
        effects: 当前 beat 的状态写入。
        state_variables: 事件图中的变量声明，用于 scalar 边界截断。

    Returns:
        应用全部 effects 后的新状态，不修改传入字典。
    """
    next_vars = dict(vars_)
    var_by_id = {var.id: var for var in state_variables or []}
    for effect in effects:
        if effect.op == "add":
            value = (next_vars.get(effect.var) or 0) + effect.value
        else:
            value = effect.value
        declaration = var_by_id.get(effect.var)
        if declaration is not None and declaration.type == "scalar":
            if declaration.min is not None:
                value = max(value, declaration.min)
            if declaration.max is not None:
                value = min(value, declaration.max)
        next_vars[effect.var] = value
    return next_vars


def find_entry(node_ids: list[str], edges: list[_DirectedEdge]) -> str | None:
    """返回第一个入度为 0 的节点；空图返回 ``None``。

    正式事件/情节图由结构校验保证单入口。保留“无入口时退回首节点”仅用于兼容旧试玩数据。
    """
    if not node_ids:
        return None
    in_degree = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        if edge.target in in_degree:
            in_degree[edge.target] += 1
    for node_id in node_ids:
        if in_degree[node_id] == 0:
            return node_id
    return node_ids[0]
