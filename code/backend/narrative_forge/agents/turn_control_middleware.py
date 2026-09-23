"""把回合停止标志接到主 Agent、子 Agent 和情节 worker 的模型/工具调用上。

停止是确定性运行控制：模型调用在启动前和进行中检查标志，已发出的请求可立即取消。
已经开始的文件写入工具等它原子替换后再抛出 :class:`AgentTurnStopped`，避免半个 JSON。
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware

from narrative_forge.agents.execution_middleware import ExecutionMiddleware
from narrative_forge.agents.recursion_budget import RecursionBudgetMiddleware
from narrative_forge.orchestrator.turn_control import (
    FILE_MUTATING_TOOLS,
    AgentTurnStopped,
    current_turn_stop,
    wait_unless_stopped,
)


def _invoke_sync_until_stopped(handler, request, controller):
    """在旁路线程跑同步调用；停止后立刻抛出，不等待线程里的 HTTP 结束。

    创建线程前复制当前 ContextVar，保证写租约、工作区和停止控制器不丢失。
    """
    box: dict[str, object] = {}
    ctx = contextvars.copy_context()

    def run() -> None:
        try:
            box["result"] = ctx.run(handler, request)
        except BaseException as exc:  # noqa: BLE001 需带回调用线程
            box["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    while thread.is_alive():
        if controller.is_stopped():
            raise AgentTurnStopped()
        thread.join(0.05)
    error = box.get("error")
    if isinstance(error, BaseException):
        raise error
    if controller.is_stopped():
        raise AgentTurnStopped()
    return box.get("result")


def _tool_name(request: Any) -> str:
    """从 LangChain 工具请求取出工具名。"""
    call = getattr(request, "tool_call", None)
    if isinstance(call, dict) and call.get("name"):
        return str(call.get("name"))
    tool = getattr(request, "tool", None)
    return str(getattr(tool, "name", "") or "tool")


class TurnControlMiddleware(AgentMiddleware):
    """在模型与工具边界检查用户停止，并统计活动工具。"""

    def wrap_model_call(self, request, handler):
        """同步模型调用：停止后不再等待整段输出。

        同步 HTTP 无法从另一线程强杀，停止后立即抛出并让图退出；后台请求可能仍会跑完，
        但不写入项目文件。
        """
        controller = current_turn_stop.get()
        if controller is None:
            return handler(request)
        controller.raise_if_stopped()
        return _invoke_sync_until_stopped(handler, request, controller)

    async def awrap_model_call(self, request, handler):
        """异步模型调用：进行中可取消，不等整段输出。"""
        controller = current_turn_stop.get()
        if controller is not None:
            controller.raise_if_stopped()
        result = await wait_unless_stopped(handler(request), controller)
        if controller is not None:
            controller.raise_if_stopped()
        return result

    def wrap_tool_call(self, request, handler):
        """同步工具：写文件等到原子结束；子任务等无文件副作用的调用停止后立刻退出。"""
        controller = current_turn_stop.get()
        if controller is not None:
            controller.raise_if_stopped()
        name = _tool_name(request)
        if controller is not None:
            controller.enter_tool(name)
        try:
            if controller is None or name in FILE_MUTATING_TOOLS:
                result = handler(request)
            else:
                result = _invoke_sync_until_stopped(handler, request, controller)
        except AgentTurnStopped:
            raise
        finally:
            if controller is not None:
                controller.leave_tool(name)
        if controller is not None:
            controller.raise_if_stopped()
        return result

    async def awrap_tool_call(self, request, handler):
        """异步工具：写文件等到原子结束；子任务/读文件/出图请求可取消。"""
        controller = current_turn_stop.get()
        if controller is not None:
            controller.raise_if_stopped()
        name = _tool_name(request)
        if controller is not None:
            controller.enter_tool(name)
        try:
            if name in FILE_MUTATING_TOOLS:
                result = await handler(request)
            else:
                result = await wait_unless_stopped(handler(request), controller)
        except AgentTurnStopped:
            raise
        except asyncio.CancelledError:
            if controller is not None and controller.is_stopped():
                raise AgentTurnStopped() from None
            raise
        finally:
            if controller is not None:
                controller.leave_tool(name)
        if controller is not None:
            controller.raise_if_stopped()
        return result


def agent_middleware() -> list:
    """主 Agent / 子 Agent 共用的中间件顺序。

    停止控制器必须在预算收口之外，这样用户停止不会转入 75/90 步部分完成。
    写租约夹在停止与预算之间：已开始的原子写会先结束，第二个写身份必须排队。
    """
    return [TurnControlMiddleware(), ExecutionMiddleware(), RecursionBudgetMiddleware()]
