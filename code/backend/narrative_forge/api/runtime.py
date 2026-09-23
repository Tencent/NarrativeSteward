"""API 运行时基建：进程内事件总线、项目级编辑锁、会话注册表（见 DESIGN §6.4/§6.5/§6.9）。

三者都是**进程内、内存态**的最小实现，足够支撑单进程本地服务：
- :class:`EventBus`：按项目分频道的发布/订阅，SSE 端点据此把"领域事件 + 任务进度"推给前端。
- :class:`ProjectLocks`：项目级互斥写操作锁——Agent 回合、正式检测和面板配图上传/生图期间该项目只读。
- :class:`SessionRegistry`：一个项目一个常驻 :class:`ProjectSession`（懒构建；进程重启丢历史）。
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from collections import defaultdict
from typing import Any
from uuid import uuid4

from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator import ProjectSession
from narrative_forge.orchestrator.turn_control import TurnStopController


class EventBus:
    """进程内、按项目分频道的发布/订阅总线，带"当前回合重放缓冲"（见 DESIGN §6.9(7)）。

    每个 SSE 连接 :meth:`subscribe` 拿到一个队列，:meth:`publish` 把事件投递给该项目下
    的所有订阅者。事件为可 JSON 序列化的 ``dict``（至少含 ``type`` 字段）。

    **重放缓冲**：后台回合任务独立于任何 SSE 连接——切走项目/断网时连接关闭，但任务仍在跑、
    仍在 publish。为让"切回来/重连"的新订阅者能恢复**进行中那一回合**的过程（步骤/流式正文），
    总线额外把"当前进行中回合"的事件留底在进程内 :attr:`_buffer`：

    - ``turn_start``：开一段新缓冲（覆盖上一段）；
    - 回合内事件（agent_text/tool_*/budget_status/data_preview_published/preview_revoked/status/data_updated/
      ``turn_stop_requested`` 等）：追加进缓冲；
    - ``turn_completed`` / ``turn_stopped`` / ``turn_end`` / ``error``：回合结束，**清空缓冲**——
      此后该回合已落盘到 ``chat.jsonl``，由 :meth:`ProjectStore.get_chat` 还原，无需再重放
      （也避免与历史或已撤销预览重复）。 ``turn_stopped`` 仍先投递给在线订阅者，再清缓冲。

    :meth:`subscribe` 会先把缓冲里的事件按序补播给新队列，再接实时流。
    """

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
        # 仅保存"当前进行中回合"的事件；键存在 == 该项目有回合在进行。
        self._buffer: dict[str, list[dict]] = {}

    def subscribe(self, project_id: str) -> asyncio.Queue:
        """为某项目新增一个订阅者，返回其专属事件队列（先补播进行中回合的缓冲）。"""
        q: asyncio.Queue = asyncio.Queue()
        for event in self._buffer.get(project_id, ()):
            q.put_nowait(event)
        self._subscribers[project_id].add(q)
        return q

    def unsubscribe(self, project_id: str, queue: asyncio.Queue) -> None:
        """移除某订阅者队列（SSE 连接断开时调用）。"""
        subs = self._subscribers.get(project_id)
        if subs:
            subs.discard(queue)
            if not subs:
                self._subscribers.pop(project_id, None)

    def publish(self, project_id: str, event: dict) -> None:
        """把事件投递给所有在线订阅者，并按回合生命周期维护重放缓冲。

        投递与缓冲解耦：无论有无订阅者，进行中回合的事件都会进缓冲（留底），
        故切走期间的事件不会"丢"，只是当时无人接收。
        """
        etype = event.get("type")
        if etype == "turn_start":
            self._buffer[project_id] = [event]
        elif project_id in self._buffer and etype not in (
            "turn_completed",
            "turn_stopped",
            "turn_end",
            "error",
        ):
            self._buffer[project_id].append(event)
        # 投递给当前在线订阅者（无订阅者则静默，缓冲已留底）。
        for q in self._subscribers.get(project_id, ()):
            q.put_nowait(event)
        # 回合结束：清空缓冲（结果已落盘，改由历史还原；停止后不得重放已撤销预览）。
        if etype in ("turn_completed", "turn_stopped", "turn_end", "error"):
            self._buffer.pop(project_id, None)


class ProjectLocks:
    """项目级写操作锁：以"忙标志"实现 Agent 回合、正式检测和面板配图上传/生图期间的互斥。

    与会等待的 ``asyncio.Lock`` 不同，这里是**非阻塞**语义：:meth:`acquire` 在项目已忙
    时立即返回 ``False``，由调用方据此拒绝并发请求（HTTP 409/423）。
    """

    def __init__(self) -> None:
        self._busy: set[str] = set()
        self._guard = asyncio.Lock()

    async def acquire(self, project_id: str) -> bool:
        """尝试将项目置为"忙"；若已忙返回 ``False``（不等待）。"""
        async with self._guard:
            if project_id in self._busy:
                return False
            self._busy.add(project_id)
            return True

    async def release(self, project_id: str) -> None:
        """释放项目的"忙"标志。"""
        async with self._guard:
            self._busy.discard(project_id)

    def is_busy(self, project_id: str) -> bool:
        """返回项目当前是否处于 Agent 回合、正式检测或面板配图上传/生图中。"""
        return project_id in self._busy


@dataclass
class ValidationRun:
    """一项进程内正式检测任务的可变运行状态。"""

    run_id: str
    status: str = "running"
    started_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )
    finished_at: str | None = None
    progress: dict[str, Any] = field(default_factory=dict)
    result_status: str | None = None
    error: str | None = None
    cancel_event: threading.Event = field(
        default_factory=threading.Event,
        repr=False,
    )

    def public(self) -> dict[str, Any]:
        """返回可直接作为 API JSON 的运行状态，不暴露线程对象。"""
        return {
            "run_id": self.run_id,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "progress": dict(self.progress),
            "result_status": self.result_status,
            "error": self.error,
        }


class ValidationRunRegistry:
    """线程安全地登记每个项目的当前/最近一次正式检测任务。"""

    def __init__(self) -> None:
        """初始化空运行表。"""
        self._runs: dict[str, ValidationRun] = {}
        self._guard = threading.Lock()

    def begin(self, project_id: str) -> ValidationRun | None:
        """开始一个任务；已有运行中/取消中的任务时返回 ``None``。"""
        with self._guard:
            current = self._runs.get(project_id)
            if current is not None and current.status in {
                "running",
                "cancelling",
            }:
                return None
            run = ValidationRun(
                run_id=uuid4().hex,
                progress={"phase": "starting", "complete": False},
            )
            self._runs[project_id] = run
            return run

    def get(self, project_id: str) -> dict[str, Any]:
        """返回项目当前/最近任务；从未运行时返回 ``idle``。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None:
                return {
                    "run_id": None,
                    "status": "idle",
                    "started_at": None,
                    "finished_at": None,
                    "progress": {},
                    "result_status": None,
                    "error": None,
                }
            return run.public()

    def update_progress(
        self,
        project_id: str,
        run_id: str,
        progress: dict[str, Any],
    ) -> None:
        """更新仍属于当前任务的传播进度。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is not None and run.run_id == run_id:
                run.progress = dict(progress)

    def request_cancel(self, project_id: str) -> dict[str, Any] | None:
        """请求取消运行中任务并返回新状态；无可取消任务时返回 ``None``。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None or run.status not in {"running", "cancelling"}:
                return None
            run.status = "cancelling"
            run.cancel_event.set()
            return run.public()

    def finish(
        self,
        project_id: str,
        run_id: str,
        *,
        status: str,
        result_status: str | None = None,
        error: str | None = None,
    ) -> None:
        """把当前任务收口为完成、取消或错误。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None or run.run_id != run_id:
                return
            run.status = status
            run.result_status = result_status
            run.error = error
            run.finished_at = datetime.now(UTC).isoformat()
            run.progress = {**run.progress, "complete": True}


_ACTIVE_TURN_STATUSES = {"running", "stop_requested", "completing"}
_STOPPABLE_TURN_STATUSES = {"running", "stop_requested"}


@dataclass
class AgentTurnRun:
    """一项进程内 Agent 回合的可变运行状态。"""

    turn_id: str
    controller: TurnStopController = field(repr=False)
    status: str = "running"
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    stop_requested_at: str | None = None
    finished_at: str | None = None

    def public(self) -> dict[str, Any]:
        """返回可直接作为 API JSON 的运行状态，不暴露控制器对象。"""
        return {
            "turn_id": self.turn_id,
            "status": self.status,
            "started_at": self.started_at,
            "stop_requested_at": self.stop_requested_at,
            "finished_at": self.finished_at,
        }


class AgentTurnRunRegistry:
    """登记每个项目当前/最近一次 Agent 回合，并处理停止与完成竞态。

    状态：``running → stop_requested → stopped``；``running → completing → completed``；
    ``running → failed``。不对后台 ``asyncio.Task`` 调用 ``cancel()``。
    """

    def __init__(self) -> None:
        """初始化空运行表。"""
        self._runs: dict[str, AgentTurnRun] = {}
        self._guard = threading.Lock()

    def begin(
        self,
        project_id: str,
        turn_id: str,
        controller: TurnStopController,
    ) -> AgentTurnRun | None:
        """开始一个回合；已有活动回合时返回 ``None``。"""
        with self._guard:
            current = self._runs.get(project_id)
            if current is not None and current.status in _ACTIVE_TURN_STATUSES:
                return None
            run = AgentTurnRun(turn_id=turn_id, controller=controller)
            self._runs[project_id] = run
            return run

    def get(self, project_id: str) -> dict[str, Any]:
        """返回项目当前/最近回合；从未运行时返回 ``idle``。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None:
                return {
                    "turn_id": None,
                    "status": "idle",
                    "started_at": None,
                    "stop_requested_at": None,
                    "finished_at": None,
                }
            return run.public()

    def get_run(self, project_id: str) -> AgentTurnRun | None:
        """返回内部运行对象，供后台回合收口；没有时为 ``None``。"""
        with self._guard:
            return self._runs.get(project_id)

    def request_stop(self, project_id: str) -> tuple[str, dict[str, Any] | None]:
        """请求停止当前回合。

        Returns:
            ``(outcome, public_state)``。outcome 为：
            ``accepted`` 第一次接受；``idempotent`` 重复停止；
            ``completing`` 正常完成已获胜；``idle`` 没有可停止的回合。
        """
        with self._guard:
            run = self._runs.get(project_id)
            if run is None or run.status not in _STOPPABLE_TURN_STATUSES:
                if run is not None and run.status in {"completing", "completed"}:
                    return "completing", run.public()
                return "idle", run.public() if run is not None else None
            if run.status == "stop_requested":
                return "idempotent", run.public()
            run.status = "stop_requested"
            first = run.controller.request_stop()
            run.stop_requested_at = run.controller.requested_at()
            return ("accepted" if first else "idempotent"), run.public()

    def mark_completing(self, project_id: str, turn_id: str) -> bool:
        """正常收口前原子进入 ``completing``。停止已获胜时返回 False。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None or run.turn_id != turn_id:
                return False
            if run.status == "stop_requested":
                return False
            if run.status != "running":
                return False
            run.status = "completing"
            return True

    def finish(self, project_id: str, turn_id: str, status: str) -> None:
        """把当前回合收口为 completed / stopped / failed。"""
        with self._guard:
            run = self._runs.get(project_id)
            if run is None or run.turn_id != turn_id:
                return
            run.status = status
            run.finished_at = datetime.now(UTC).isoformat()


class SessionRegistry:
    """常驻会话注册表：一个项目一个 :class:`ProjectSession`（懒构建）。

    Args:
        store: 项目存储，用于构建会话内的主 Agent。
    """

    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self._sessions: dict[str, ProjectSession] = {}

    def get(self, project_id: str) -> ProjectSession:
        """获取（或首次构建）某项目的常驻会话。"""
        sess = self._sessions.get(project_id)
        if sess is None:
            sess = ProjectSession(self.store, project_id)
            self._sessions[project_id] = sess
        return sess

    def drop(self, project_id: str) -> None:
        """丢弃某项目的会话（如重置对话历史时用）。"""
        self._sessions.pop(project_id, None)
