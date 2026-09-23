"""写租约与检查点中间件：同一回合内所有写身份串行，task 结束后发布预览。

首版不实现只读并行。未来若增加明确的只读分析身份，只能让它们读取同一不可变
快照，并由禁写 backend 保证不会落盘。
"""

from __future__ import annotations

import asyncio
import threading
from contextvars import ContextVar
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware

from narrative_forge.orchestrator.trace_context import emit_nested_event
from narrative_forge.orchestrator.turn_control import (
    FILE_MUTATING_TOOLS,
    get_turn_stop,
)

# 需要占用写租约的工具：子 Agent 任务、文件写入、配图、正式检测。
LEASE_TOOLS = frozenset(
    {
        "task",
        "write_file",
        "edit_file",
        "generate_card_image",
        "run_state_validation",
    }
)

# 用户可见的检查点失败提示；详细错误只走 Agent 工具返回值 / [系统校验]。
CHECKPOINT_INVALID_CODE = "checkpoint_invalid"
CHECKPOINT_INVALID_USER_TEXT = (
    "本次中间结果未通过一致性检查，当前仍显示上一有效版本。"
)


def checkpoint_invalid_user_status() -> dict[str, str]:
    """构造发给前端的检查点失败 ``status`` 载荷，不含逐片段错误。"""
    return {
        "text": CHECKPOINT_INVALID_USER_TEXT,
        "phase": CHECKPOINT_INVALID_CODE,
        "code": CHECKPOINT_INVALID_CODE,
        "audience": "user",
    }

current_write_lease: ContextVar["WriteLeaseCoordinator | None"] = ContextVar(
    "current_write_lease",
    default=None,
)
_lease_depth: ContextVar[int] = ContextVar("write_lease_depth", default=0)
current_turn_workspace: ContextVar[Any] = ContextVar(
    "current_turn_workspace",
    default=None,
)


class WriteLeaseCoordinator:
    """项目回合内的可重入写租约。

    同一异步调用链可嵌套持有（子 Agent 内部的 write_file 继承 task 的租约）。
    并发发出的第二个 ``task`` 必须等待前一个释放。
    """

    def __init__(self) -> None:
        self._async_lock = asyncio.Lock()
        self._sync_lock = threading.Lock()

    def hold_async(self) -> "_AsyncLease":
        """返回异步租约上下文。"""
        return _AsyncLease(self)

    def hold_sync(self):
        """同步上下文：获取或重入写租约。"""
        return _SyncLease(self)


class _AsyncLease:
    """异步可重入租约。"""

    def __init__(self, coordinator: WriteLeaseCoordinator) -> None:
        self._coordinator = coordinator
        self._acquired = False

    async def __aenter__(self) -> "_AsyncLease":
        depth = _lease_depth.get()
        if depth > 0:
            _lease_depth.set(depth + 1)
            return self
        await self._coordinator._async_lock.acquire()
        self._acquired = True
        _lease_depth.set(1)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        depth = _lease_depth.get()
        if depth > 1:
            _lease_depth.set(depth - 1)
            return
        _lease_depth.set(0)
        if self._acquired:
            self._coordinator._async_lock.release()


class _SyncLease:
    """同步可重入租约。"""

    def __init__(self, coordinator: WriteLeaseCoordinator) -> None:
        self._coordinator = coordinator
        self._acquired = False

    def __enter__(self) -> "_SyncLease":
        depth = _lease_depth.get()
        if depth > 0:
            _lease_depth.set(depth + 1)
            return self
        self._coordinator._sync_lock.acquire()
        self._acquired = True
        _lease_depth.set(1)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        depth = _lease_depth.get()
        if depth > 1:
            _lease_depth.set(depth - 1)
            return
        _lease_depth.set(0)
        if self._acquired:
            self._coordinator._sync_lock.release()


def _tool_name(request: Any) -> str:
    """从 LangChain 工具请求取出工具名。"""
    call = getattr(request, "tool_call", None)
    if isinstance(call, dict) and call.get("name"):
        return str(call.get("name"))
    tool = getattr(request, "tool", None)
    return str(getattr(tool, "name", "") or "tool")


def _tool_call_id(request: Any) -> str | None:
    """取出工具调用 id，供检查点挂到对应步骤。"""
    call = getattr(request, "tool_call", None)
    if isinstance(call, dict):
        return str(call.get("id") or call.get("run_id") or "") or None
    return None


def _publish_task_checkpoint(step_id: str | None) -> str | None:
    """子 Agent 返回后尝试冻结预览；失败则回灌事件并返回可附加到 task 结果的错误说明。"""
    from narrative_forge.orchestrator.session import TurnEvent
    from narrative_forge.orchestrator.turn_workspace import snapshot_to_bundle

    workspace = current_turn_workspace.get()
    if workspace is None:
        return None
    from narrative_forge.orchestrator.turn_validation import (
        capture_fragment_map,
        validate_fragment_maps,
    )

    service = getattr(workspace, "service", None)
    if service is None:
        current = capture_fragment_map(workspace.draft_store, workspace.project_id)
        report = validate_fragment_maps(workspace.checkpoint, current)
        if not report.ok:
            errors = report.as_invalid_map()
            emit_nested_event(TurnEvent("status", checkpoint_invalid_user_status()))
            return _format_checkpoint_feedback(errors)
        return None
    snapshot = service.publish_checkpoint(workspace, step_id=step_id)
    if snapshot is None:
        current = capture_fragment_map(workspace.draft_store, workspace.project_id)
        report = validate_fragment_maps(workspace.checkpoint, current)
        if not report.ok:
            errors = report.as_invalid_map()
            emit_nested_event(TurnEvent("status", checkpoint_invalid_user_status()))
            return _format_checkpoint_feedback(errors)
        return None
    emit_nested_event(
        TurnEvent(
            "data_preview_published",
            {
                **snapshot_to_bundle(snapshot, turn_id=workspace.turn_id),
                "step_id": step_id,
                "source": "agent_preview",
            },
        )
    )
    return None


def _format_checkpoint_feedback(errors: dict[str, str]) -> str:
    """把检查点错误整理成可追加到 task 结果的说明。"""
    lines = ["[系统校验] 本子任务写入未通过基础验收，预览未发布。请修正："]
    for key, message in errors.items():
        lines.append(f"\n{key}：\n{message}")
    return "\n".join(lines)


def _append_tool_result(result: Any, extra: str) -> Any:
    """把检查点错误附加到子任务返回值，供主 Agent 继续修复。"""
    if not extra:
        return result
    if result is None:
        return extra
    if isinstance(result, str):
        return f"{result}\n\n{extra}"
    content = getattr(result, "content", None)
    if isinstance(content, str):
        try:
            result.content = f"{content}\n\n{extra}"
            return result
        except Exception:
            return f"{content}\n\n{extra}"
    return f"{result}\n\n{extra}"


class ExecutionMiddleware(AgentMiddleware):
    """串行写租约，并在 ``task`` 成功返回后发布检查点预览。"""

    def wrap_tool_call(self, request, handler):
        """同步工具：写类工具进入租约；task 返回后尝试发布预览。"""
        name = _tool_name(request)
        coordinator = current_write_lease.get()
        if coordinator is None or name not in LEASE_TOOLS:
            return handler(request)
        controller = get_turn_stop()
        if controller is not None:
            controller.raise_if_stopped()
        with coordinator.hold_sync():
            result = handler(request)
            if name == "task":
                extra = _publish_task_checkpoint(_tool_call_id(request))
                result = _append_tool_result(result, extra or "")
            return result

    async def awrap_tool_call(self, request, handler):
        """异步工具：语义与同步版本相同。"""
        name = _tool_name(request)
        coordinator = current_write_lease.get()
        if coordinator is None or name not in LEASE_TOOLS:
            return await handler(request)
        controller = get_turn_stop()
        if controller is not None:
            controller.raise_if_stopped()
        async with coordinator.hold_async():
            result = await handler(request)
            if name == "task":
                extra = _publish_task_checkpoint(_tool_call_id(request))
                result = _append_tool_result(result, extra or "")
            return result
