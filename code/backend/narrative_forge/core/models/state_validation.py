"""紧凑联合状态传播的正式问题报告与按需路线解释。"""

from __future__ import annotations

import time
from typing import Any, Callable

from narrative_forge.core.models.compact_propagation import (
    propagate_compact_states,
    restore_route_to_position,
)
from narrative_forge.core.models.event_graph import EventGraph
from narrative_forge.core.models.scene_graph import SceneGraph

ENGINE_VERSION = "state-propagation/v1"
REPORT_SCHEMA_VERSION = 8


def _issue(kind: str, message: str, **details: Any) -> dict[str, Any]:
    """构造稳定、可 JSON 序列化的问题项。

    Args:
        kind: 稳定问题类型。
        message: 面向创作者的说明。
        **details: 结构化定位、状态和路线信息。

    Returns:
        问题字典。
    """
    return {"kind": kind, "message": message, **details}


def _empty_complexity() -> dict[str, Any]:
    """返回未运行传播时的稳定空复杂度结构。"""
    return {
        "condition_variables": [],
        "max_live_variables": 0,
        "peak_states_at_position": 0,
        "peak_frontier_states": 0,
        "top_positions": [],
    }


def _edge_message(diagnostic: dict[str, Any]) -> str:
    """生成永远无法解锁边的人读说明。

    Args:
        diagnostic: 紧凑传播产生的边诊断。

    Returns:
        包含边 id、条件和实际可达值摘要的消息。
    """
    edge_id = diagnostic["edge_id"]
    condition = diagnostic.get("condition")
    if not diagnostic.get("source_reached"):
        return f"边 {edge_id} 的源节点不可达，因此该选择也无法出现"
    if condition is None:
        return f"边 {edge_id} 的源节点可达，但传播中从未执行该无条件边"
    values = diagnostic.get("observed_values", [])
    return (
        f"边 {edge_id} 要求 {condition['var']} {condition['op']} "
        f"{condition['value']!r}，但源位置实际可达值为 {values!r}"
    )


def _unused_variable_warnings(
    graph: EventGraph,
    scenes: list[SceneGraph],
) -> list[dict[str, Any]]:
    """返回从未被任何条件读取的状态变量提醒。"""
    read_variable_ids = {
        edge.condition.var
        for edge in graph.edges
        if edge.condition is not None
    }
    for scene in scenes:
        read_variable_ids.update(
            edge.condition.var
            for edge in scene.edges
            if edge.condition is not None
        )
    return [
        {
            "kind": "state_variable_never_read",
            "message": (
                f"状态变量 {variable.name}（{variable.id}）从未被任何 condition 读取，"
                "当前不会影响选择、路线或结局"
            ),
            "variable_id": variable.id,
            "variable_type": variable.type,
        }
        for variable in graph.state_variables
        if variable.id not in read_variable_ids
    ]


def _report_warnings(
    graph: EventGraph,
    scenes: list[SceneGraph],
    world_data: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """返回未读取变量等非阻塞提醒。

    ``world_data`` 保留以兼容既有调用方；speaker 已改为保存期硬错误，不再进入警告。
    """
    del world_data
    return _unused_variable_warnings(graph, scenes)


def build_incomplete_state_validation_report(
    graph: EventGraph,
    scenes: list[SceneGraph],
    *,
    extra_issues: list[dict[str, Any]] | None = None,
    missing_scene_ids: set[str] | None = None,
    world_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """为 scene 不齐全的项目构造报告，不运行联合状态传播。

    Args:
        graph: 已解析的事件图。
        scenes: 当前可解析的情节图。
        extra_issues: 基础结构检查已发现的附加问题。
        missing_scene_ids: 确实不存在文件的 scene id；不传时按已解析 scene 推导。
        world_data: 世界设定原始字典；speaker 硬引用已在预检阶段处理，此处仅保留兼容参数。

    Returns:
        状态固定为 ``incomplete`` 的正式报告。
    """
    scene_ids = {scene.event_id for scene in scenes}
    missing_ids = missing_scene_ids or {
        node.id for node in graph.nodes if node.id not in scene_ids
    }
    issues = list(extra_issues or [])
    for node in graph.nodes:
        if node.id in missing_ids:
            issues.append(
                _issue(
                    "scene_missing",
                    f"事件 {node.id} 的情节尚未生成",
                    event_id=node.id,
                )
            )
    warnings = _report_warnings(graph, scenes, world_data)
    return {
        "engine_version": ENGINE_VERSION,
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "status": "incomplete",
        "summary": {
            "events_reached": 0,
            "events_total": len(graph.nodes),
            "beats_reached": 0,
            "beats_total": sum(len(scene.beats) for scene in scenes),
            "edges_used": 0,
            "edges_total": len(graph.edges)
            + sum(len(scene.edges) for scene in scenes),
            "dead_end_states": 0,
            "states_explored": 0,
            "issue_count": len(issues),
            "warning_count": len(warnings),
        },
        "issues": issues,
        "warnings": warnings,
        "complexity": _empty_complexity(),
        "meta": {
            "complete": True,
            "propagation_ran": False,
            "reason": "missing_scenes",
            "propagation_elapsed_ms": 0.0,
            "route_restore_elapsed_ms": 0.0,
        },
    }


def build_preflight_failure_report(
    graph: EventGraph,
    scenes: list[SceneGraph],
    issues: list[dict[str, Any]],
    *,
    world_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """为基础结构非法但内容齐全的项目构造 ``failed`` 报告。"""
    warnings = _report_warnings(graph, scenes, world_data)
    return {
        "engine_version": ENGINE_VERSION,
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "status": "failed",
        "summary": {
            "events_reached": 0,
            "events_total": len(graph.nodes),
            "beats_reached": 0,
            "beats_total": sum(len(scene.beats) for scene in scenes),
            "edges_used": 0,
            "edges_total": len(graph.edges)
            + sum(len(scene.edges) for scene in scenes),
            "dead_end_states": 0,
            "states_explored": 0,
            "issue_count": len(issues),
            "warning_count": len(warnings),
        },
        "issues": issues,
        "warnings": warnings,
        "complexity": _empty_complexity(),
        "meta": {
            "complete": True,
            "propagation_ran": False,
            "reason": "preflight_failed",
            "propagation_elapsed_ms": 0.0,
            "route_restore_elapsed_ms": 0.0,
        },
    }


def build_state_validation_report(
    graph: EventGraph,
    scenes: list[SceneGraph],
    *,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    progress_every: int = 100_000,
    cancel_check: Callable[[], None] | None = None,
    world_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """运行紧凑传播并构建稳定问题报告。

    Args:
        graph: 已通过 Pydantic 解析的事件图。
        scenes: 已通过 Pydantic 解析的情节图。
        progress_callback: 可选传播进度回调。
        progress_every: 每处理多少个紧凑状态上报一次进度。
        cancel_check: 可选取消检查。
        world_data: 世界设定原始字典；speaker 硬引用已在预检阶段处理，此处仅保留兼容参数。

    Returns:
        正式报告。缺 scene 时为 ``incomplete``；完整内容存在任一节点、边或死路问题时为
        ``failed``；全部覆盖时为 ``passed``。
    """
    scene_by_event = {scene.event_id: scene for scene in scenes}
    missing_scene_ids = [
        node.id for node in graph.nodes if node.id not in scene_by_event
    ]
    if missing_scene_ids:
        return build_incomplete_state_validation_report(
            graph, scenes, world_data=world_data
        )
    propagation_started = time.perf_counter()
    propagation = propagate_compact_states(
        graph,
        scenes,
        progress_callback=progress_callback,
        progress_every=progress_every,
        cancel_check=cancel_check,
    )
    propagation_elapsed_ms = round(
        (time.perf_counter() - propagation_started) * 1000, 2
    )
    issues: list[dict[str, Any]] = []
    warnings = _report_warnings(graph, scenes, world_data)

    unreachable_event_ids = {
        item["id"]
        for item in propagation["unreachable_nodes"]["events"]
    }
    for item in propagation["unreachable_nodes"]["events"]:
        issues.append(
            _issue(
                "event_unreachable",
                f"事件 {item['title']}（{item['id']}）无法从游戏入口到达",
                event_id=item["id"],
                node_type=item["type"],
                cascade=bool(missing_scene_ids),
            )
        )
    for group in propagation["unreachable_nodes"]["beats"]:
        for beat_id in group["beat_ids"]:
            issues.append(
                _issue(
                    "beat_unreachable",
                    f"事件 {group['event_id']} 的情节节点 {beat_id} 无法到达",
                    event_id=group["event_id"],
                    beat_id=beat_id,
                    cascade=group["event_id"] in unreachable_event_ids,
                )
            )

    route_cache: dict[str, dict[str, Any] | None] = {}
    route_restore_states = 0
    route_restore_started = time.perf_counter()
    for diagnostic in propagation["edge_coverage"]["diagnostics"]:
        if diagnostic["used"]:
            continue
        source_position = diagnostic["source_position"]
        route = None
        if diagnostic["source_reached"]:
            if source_position not in route_cache:
                route_cache[source_position] = restore_route_to_position(
                    graph,
                    scenes,
                    source_position,
                    cancel_check=cancel_check,
                )
                restored = route_cache[source_position]
                if restored is not None:
                    route_restore_states += restored["states_examined"]
            route = route_cache[source_position]
        issues.append(
            _issue(
                (
                    "event_edge_never_enabled"
                    if diagnostic["kind"] == "event_edge"
                    else "scene_edge_never_enabled"
                ),
                _edge_message(diagnostic),
                event_id=diagnostic["event_id"],
                edge_id=diagnostic["edge_id"],
                edge_tag=diagnostic["edge_tag"],
                source_position=source_position,
                target_position=diagnostic["target_position"],
                condition=diagnostic["condition"],
                reachable_values=diagnostic["observed_values"],
                route=route,
                cascade=not diagnostic["source_reached"],
            )
        )

    for group in propagation["dead_ends"]["groups"]:
        samples = []
        for sample in group["samples"]:
            route = restore_route_to_position(
                graph,
                scenes,
                group["position"],
                target_after_state=sample["packed_state"],
                cancel_check=cancel_check,
            )
            if route is not None:
                route_restore_states += route["states_examined"]
            samples.append(
                {
                    "state": sample["state"],
                    "unmet_conditions": sample["unmet_conditions"],
                    "route": route,
                }
            )
        issues.append(
            _issue(
                "dead_end_state",
                f"位置 {group['position']} 存在 {group['count']} 个无可用出边的可达状态",
                event_id=group["event_id"],
                beat_id=group["beat_id"],
                position=group["position"],
                occurrences=group["count"],
                samples=samples,
            )
        )
    route_restore_elapsed_ms = round(
        (time.perf_counter() - route_restore_started) * 1000, 2
    )

    if issues:
        status = "failed"
    else:
        status = "passed"

    propagation_summary = propagation["summary"]
    return {
        "engine_version": ENGINE_VERSION,
        "report_schema_version": REPORT_SCHEMA_VERSION,
        "status": status,
        "summary": {
            "events_reached": propagation_summary["reachable_event_count"],
            "events_total": propagation_summary["total_event_count"],
            "beats_reached": sum(len(scene.beats) for scene in scenes)
            - sum(
                len(group["beat_ids"])
                for group in propagation["unreachable_nodes"]["beats"]
            ),
            "beats_total": sum(len(scene.beats) for scene in scenes),
            "edges_used": propagation["edge_coverage"]["used"],
            "edges_total": propagation["edge_coverage"]["total"],
            "dead_end_states": propagation_summary["dead_end_count"],
            "states_explored": propagation["meta"]["configs_explored"],
            "issue_count": len(issues),
            "warning_count": len(warnings),
        },
        "issues": issues,
        "warnings": warnings,
        "complexity": {
            "condition_variables": propagation["state_space"][
                "condition_variables"
            ],
            "max_live_variables": max(
                propagation["meta"]["max_live_before_vars"],
                propagation["meta"]["max_live_after_vars"],
            ),
            "peak_states_at_position": propagation["state_space"][
                "peak_position_states"
            ],
            "peak_frontier_states": propagation["state_space"][
                "peak_frontier_states"
            ],
            "top_positions": propagation["state_space"]["top_positions"],
        },
        "meta": {
            **propagation["meta"],
            "route_restore_states_examined": route_restore_states,
            "propagation_elapsed_ms": propagation_elapsed_ms,
            "route_restore_elapsed_ms": route_restore_elapsed_ms,
            "propagation_ran": True,
        },
    }
