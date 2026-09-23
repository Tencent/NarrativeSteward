"""全部 scalar 的双侧有界整数保存契约。"""

from __future__ import annotations

from typing import Any, Iterable

from narrative_forge.core.models.event_graph import EventGraph, StateVariable
from narrative_forge.core.models.scene_graph import SceneGraph


def is_finite_integer(value: Any) -> bool:
    """判断值是否为严格整数，显式排除布尔值。

    Args:
        value: 待检查值。

    Returns:
        仅非布尔 ``int`` 返回 ``True``。
    """
    return isinstance(value, int) and not isinstance(value, bool)


def condition_scalar_ids(
    graph: EventGraph,
    scenes: Iterable[SceneGraph],
) -> set[str]:
    """收集全项目被任意 condition 引用的 scalar id。

    Args:
        graph: 事件图及全局变量声明。
        scenes: 已解析的全部情节图。

    Returns:
        条件 scalar id 集合。未声明或非 scalar 引用由已有结构校验负责，不纳入本集合。
    """
    scalar_ids = {
        variable.id
        for variable in graph.state_variables
        if variable.type == "scalar"
    }
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
    return scalar_ids & referenced


def _integer_error(label: str, value: Any) -> str | None:
    """返回有限整数错误；合法时返回 ``None``。"""
    if is_finite_integer(value):
        return None
    return f"{label} 必须是有限整数，当前为 {value!r}"


def validate_scalar_contract(
    graph: EventGraph,
    scenes: Iterable[SceneGraph],
) -> list[str]:
    """校验全项目全部 scalar 的声明、条件值和写入值。

    Args:
        graph: 事件图及全局变量声明。
        scenes: 与候选内容组成同一项目视图的全部情节图。

    Returns:
        可直接显示给编辑器或 Agent 的错误列表；为空表示契约通过。
    """
    scene_list = list(scenes)
    variable_by_id: dict[str, StateVariable] = {
        variable.id: variable for variable in graph.state_variables
    }
    scalar_ids = {
        variable.id
        for variable in graph.state_variables
        if variable.type == "scalar"
    }
    errors: list[str] = []

    for variable in graph.state_variables:
        if variable.id not in scalar_ids:
            continue
        if variable.min is None or variable.max is None:
            errors.append(
                f"scalar {variable.id} 必须同时声明 min/max"
            )
            continue
        for field_name, value in (
            ("min", variable.min),
            ("max", variable.max),
        ):
            error = _integer_error(
                f"scalar {variable.id}.{field_name}",
                value,
            )
            if error is not None:
                errors.append(error)
        if variable.initial is not None:
            error = _integer_error(
                f"scalar {variable.id}.initial",
                variable.initial,
            )
            if error is not None:
                errors.append(error)

    for edge in graph.edges:
        condition = edge.condition
        if condition is None or condition.var not in scalar_ids:
            continue
        error = _integer_error(
            f"事件边 {edge.id or f'{edge.source}->{edge.target}'} "
            f"scalar {condition.var} 的比较值",
            condition.value,
        )
        if error is not None:
            errors.append(error)

    for scene in scene_list:
        for edge in scene.edges:
            condition = edge.condition
            if condition is None or condition.var not in scalar_ids:
                continue
            error = _integer_error(
                f"事件 {scene.event_id} 的 scene 边 "
                f"{edge.id or f'{edge.source}->{edge.target}'} "
                f"scalar {condition.var} 的比较值",
                condition.value,
            )
            if error is not None:
                errors.append(error)
        for beat in scene.beats:
            for effect in beat.effects:
                variable = variable_by_id.get(effect.var)
                if (
                    variable is None
                    or variable.type != "scalar"
                    or effect.var not in scalar_ids
                ):
                    continue
                error = _integer_error(
                    f"事件 {scene.event_id} 的 beat {beat.id} effect "
                    f"{effect.var}.{effect.op}",
                    effect.value,
                )
                if error is not None:
                    errors.append(error)
    return errors
