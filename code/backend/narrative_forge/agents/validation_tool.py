"""主 Agent 的正式完整可玩性检测工具。"""

from __future__ import annotations

from threading import Event

from langchain_core.tools import tool

from narrative_forge.core.state_validation_service import (
    StateValidationCancelled,
    run_state_validation_for_project,
)
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.turn_control import AgentTurnStopped, get_turn_stop


def _route_summary(route: object) -> dict | None:
    """把长解释路线压缩为 Agent 修复所需的定位摘要。

    Args:
        route: 正式报告中的可选路线对象。

    Returns:
        包含步数、目标状态和末尾步骤的摘要；无路线时返回 ``None``。
    """
    if not isinstance(route, dict):
        return None
    steps = route.get("steps")
    normalized_steps = steps if isinstance(steps, list) else []
    return {
        "step_count": len(normalized_steps),
        "target_position": route.get("target_position"),
        "target_state": route.get("target_state"),
        "tail_steps": normalized_steps[-12:],
    }


def _issue_for_agent(issue: dict) -> dict:
    """裁剪一个正式问题，同时保留对话修复需要的结构化事实。

    Args:
        issue: ``state-propagation/v1`` 的原始问题。

    Returns:
        不含超长完整路线、但保留定位、条件和值的问题摘要。
    """
    keys = (
        "kind",
        "message",
        "event_id",
        "beat_id",
        "edge_id",
        "edge_tag",
        "position",
        "source_position",
        "target_position",
        "condition",
        "reachable_values",
        "state",
        "occurrences",
        "cascade",
    )
    summary = {key: issue[key] for key in keys if key in issue}
    route = _route_summary(issue.get("route"))
    if route is not None:
        summary["route"] = route
    samples = issue.get("samples")
    if isinstance(samples, list):
        summary["samples"] = [
            {
                key: value
                for key, value in (
                    ("state", sample.get("state")),
                    ("unmet_conditions", sample.get("unmet_conditions")),
                    ("route", _route_summary(sample.get("route"))),
                )
                if value is not None
            }
            for sample in samples[:3]
            if isinstance(sample, dict)
        ]
    return summary


def build_latest_validation_tool(store: ProjectStore, project_id: str):
    """构建读取当前有效正式检测报告的只读工具。

    Args:
        store: 项目存储。
        project_id: 当前主 Agent 所属项目。

    Returns:
        支持问题筛选与分页、不会重新运行检测的 LangChain 工具。
    """

    @tool("read_latest_state_validation")
    def read_latest_state_validation(
        kind: str = "",
        event_id: str = "",
        include_cascades: bool = False,
        offset: int = 0,
        limit: int = 20,
    ) -> dict:
        """读取与当前保存内容完全一致的最近正式检测结果，不重新检测。

        当用户提到“最新检测结果”“这些问题”或要求根据检测报告修复时优先调用。
        可用 ``kind``、``event_id`` 筛选；默认隐藏由上游问题造成的连锁项并返回前 20 个根因。
        若 ``has_more`` 为 true，可增加 ``offset`` 继续读取。内容已修改导致报告失效时，
        本工具只返回 ``not_checked``，不得把旧报告当成当前结论。

        Args:
            kind: 可选稳定问题类型，例如 ``scene_edge_never_enabled``。
            event_id: 可选事件 id。
            include_cascades: 是否包含标记为连锁影响的问题。
            offset: 匹配问题的分页起点，必须非负。
            limit: 本页问题数，限制为 1--50。
        """
        state = store.validation_state(project_id)
        report = state.get("report")
        if not isinstance(report, dict):
            return {
                "status": "not_checked",
                "checked_at": state.get("checked_at"),
                "current_fingerprint": state.get("current_fingerprint"),
                "message": "当前保存内容没有仍然有效的正式检测报告，请先由用户明确要求运行完整检测。",
                "issues": [],
                "has_more": False,
            }

        issues = [
            issue
            for issue in report.get("issues") or []
            if isinstance(issue, dict)
            and (include_cascades or issue.get("cascade") is not True)
            and (not kind or issue.get("kind") == kind)
            and (not event_id or issue.get("event_id") == event_id)
        ]
        safe_offset = max(0, offset)
        safe_limit = min(50, max(1, limit))
        page = issues[safe_offset : safe_offset + safe_limit]
        complexity = report.get("complexity") or {}
        variables = complexity.get("condition_variables") or []
        return {
            "status": state.get("status"),
            "checked_at": state.get("checked_at"),
            "current_fingerprint": state.get("current_fingerprint"),
            "engine_version": report.get("engine_version"),
            "report_schema_version": report.get("report_schema_version"),
            "summary": report.get("summary"),
            "variable_names": {
                variable["id"]: variable.get("name") or variable["id"]
                for variable in variables
                if isinstance(variable, dict) and variable.get("id")
            },
            "warnings": (report.get("warnings") or [])[:20],
            "matched_issue_count": len(issues),
            "offset": safe_offset,
            "limit": safe_limit,
            "issues": [_issue_for_agent(issue) for issue in page],
            "has_more": safe_offset + len(page) < len(issues),
        }

    return read_latest_state_validation


def build_state_validation_tool(store: ProjectStore, project_id: str):
    """构建绑定项目的 ``run_state_validation`` 工具。

    Args:
        store: 项目存储。
        project_id: 当前主 Agent 所属项目。

    Returns:
        一个复用正式检测服务、仅返回有限问题摘要的 LangChain 工具。
    """

    @tool("run_state_validation")
    def run_state_validation() -> dict:
        """仅当用户明确要求完整检测当前版本时调用。

        对完整项目传播全部有限联合状态，保存正式检测记录并返回结构化摘要。若本轮还要修改内容，
        必须先完成修改再调用；不要自行读取文件或重新实现可达性判断。
        """
        controller = get_turn_stop()
        if controller is not None:
            controller.raise_if_stopped()
        cancel_event: Event | None = (
            controller.cancel_event() if controller is not None else None
        )
        try:
            result = run_state_validation_for_project(
                store,
                project_id,
                cancel_event=cancel_event,
            )
        except StateValidationCancelled:
            if controller is not None and controller.is_stopped():
                raise AgentTurnStopped() from None
            raise
        if controller is not None:
            controller.raise_if_stopped()
        report = result.get("report") or {}
        issues = report.get("issues") or []
        return {
            "saved": result.get("saved", False),
            "status": result.get("status"),
            "message": result.get("message"),
            "current_fingerprint": result.get("current_fingerprint"),
            "engine_version": report.get("engine_version"),
            "report_schema_version": report.get("report_schema_version"),
            "summary": report.get("summary"),
            "issue_count": len(issues),
            "issues": issues[:20],
        }

    return run_state_validation
