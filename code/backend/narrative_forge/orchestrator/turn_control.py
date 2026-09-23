"""Agent 回合协作式停止：控制器、上下文变量与用户中止专用异常。

停止不是 ``asyncio.CancelledError``，也不是正式检测取消。请求被接受后，不再启动
新的模型调用或工具；无项目副作用的模型/出图 HTTP 立即取消，已经开始的文件原子写入
到达安全边界后再退出，由 API 层整轮回滚。
"""

from __future__ import annotations

import asyncio
import threading
import time
from contextvars import ContextVar
from datetime import UTC, datetime

# 停止后轮询当前请求是否该取消的间隔；过长会让停止体感变慢，过短会空转。
STOP_POLL_INTERVAL = 0.05

# 只有这些工具改项目文件，停止时必须等当前这次原子写入结束。
# ``task`` / 读文件 / 出图请求本身不算，否则会把整段子 Agent 或模型输出等完。
FILE_MUTATING_TOOLS = frozenset(
    {"write_file", "edit_file", "generate_card_image"}
)


class AgentTurnStopped(Exception):
    """用户主动停止当前 Agent 回合。

    不得复用 ``asyncio.CancelledError`` 或检测取消异常，以便日志和回滚提示
    将用户主动停止与技术失败、检测取消区分开。
    """


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO-8601 字符串。"""
    return datetime.now(UTC).isoformat()


class TurnStopController:
    """单个 Agent 回合的协作式停止标志与活动工具计数。

    Args:
        turn_id: 本轮稳定 id，与 API / SSE 共用。
    """

    def __init__(self, turn_id: str) -> None:
        self.turn_id = turn_id
        self._guard = threading.Lock()
        self._stop_event = threading.Event()
        self._requested_at: str | None = None
        self._requested_mono: float | None = None
        self._active_tools: list[str] = []
        self._seen_tool_types: list[str] = []
        self._created_mono = time.perf_counter()

    def request_stop(self) -> bool:
        """登记停止请求。第一次返回 True，重复请求返回 False。"""
        with self._guard:
            if self._stop_event.is_set():
                return False
            self._stop_event.set()
            self._requested_at = _now_iso()
            self._requested_mono = time.perf_counter()
            return True

    def is_stopped(self) -> bool:
        """是否已经接受停止请求。"""
        return self._stop_event.is_set()

    def raise_if_stopped(self) -> None:
        """若已请求停止则抛出 :class:`AgentTurnStopped`。"""
        if self._stop_event.is_set():
            raise AgentTurnStopped()

    def enter_tool(self, tool_type: str) -> None:
        """记录一个已经开始、必须等到安全边界的工具。"""
        name = str(tool_type or "tool")
        with self._guard:
            self._active_tools.append(name)
            if name not in self._seen_tool_types:
                self._seen_tool_types.append(name)

    def leave_tool(self, tool_type: str) -> None:
        """工具到达安全边界后减少活动计数。"""
        name = str(tool_type or "tool")
        with self._guard:
            if name in self._active_tools:
                self._active_tools.remove(name)
            elif self._active_tools:
                self._active_tools.pop()

    def has_active_tools(self) -> bool:
        """是否仍有已经开始、尚未返回的工具。"""
        with self._guard:
            return bool(self._active_tools)

    def has_file_mutating_tools(self) -> bool:
        """是否仍有正在写项目文件、必须等到原子替换结束的工具。"""
        with self._guard:
            return any(name in FILE_MUTATING_TOOLS for name in self._active_tools)

    def active_tool_types(self) -> list[str]:
        """返回当前仍在执行的工具类型快照。"""
        with self._guard:
            return list(self._active_tools)

    def seen_tool_types(self) -> list[str]:
        """返回本轮实际启动过的工具类型。"""
        with self._guard:
            return list(self._seen_tool_types)

    def requested_at(self) -> str | None:
        """停止请求被接受的时间；尚未请求时为 ``None``。"""
        return self._requested_at

    def stop_delay_ms(self) -> int:
        """从接受停止请求到当前时刻的毫秒数；尚未请求时为 0。"""
        with self._guard:
            started = self._requested_mono
        if started is None:
            return 0
        return max(0, int((time.perf_counter() - started) * 1000))

    def cancel_event(self) -> threading.Event:
        """供正式检测等同步循环轮询的线程安全取消标志。"""
        return self._stop_event


current_turn_stop: ContextVar[TurnStopController | None] = ContextVar(
    "current_turn_stop",
    default=None,
)


def get_turn_stop() -> TurnStopController | None:
    """返回当前任务上下文中的停止控制器；不在回合内时为 ``None``。"""
    return current_turn_stop.get()


def _discard_task_result(task: asyncio.Task) -> None:
    """取走已取消后台任务的结果，避免“未取回异常”告警。"""
    try:
        task.exception()
    except (asyncio.CancelledError, asyncio.InvalidStateError, Exception):
        pass


async def wait_unless_stopped(
    awaitable,
    controller: TurnStopController | None,
    *,
    interval: float = STOP_POLL_INTERVAL,
):
    """等待协程完成；已请求停止且没有写文件时取消该协程并立即抛出，不等待它自然结束。

    Args:
        awaitable: 模型请求或其它无项目副作用的异步调用。
        controller: 当前回合停止控制器；``None`` 时直接等待完成。
        interval: 查看停止标志的间隔秒数。

    Returns:
        ``awaitable`` 的结果。

    Raises:
        AgentTurnStopped: 等待期间或开始前已请求停止。
    """
    if controller is None:
        return await awaitable
    controller.raise_if_stopped()
    task = asyncio.ensure_future(awaitable)
    try:
        while not task.done():
            if controller.is_stopped() and not controller.has_file_mutating_tools():
                task.cancel()
                task.add_done_callback(_discard_task_result)
                raise AgentTurnStopped()
            await asyncio.wait({task}, timeout=interval)
        return task.result()
    except AgentTurnStopped:
        raise
    except asyncio.CancelledError:
        if not task.done():
            task.cancel()
            task.add_done_callback(_discard_task_result)
        if controller.is_stopped():
            raise AgentTurnStopped() from None
        raise
