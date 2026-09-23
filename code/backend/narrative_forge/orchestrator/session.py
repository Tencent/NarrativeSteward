"""项目会话编排：把"一次用户对话"封装为草稿写入、检查点预览与回合末统一验收。

职责（见 docs/DESIGN.md §6）：
- 维护一个项目级会话的消息历史（一个项目 = 一个 session）。
- 生产回合写入与正式项目隔离的草稿；测试注入的假 Agent 仍可直写当前 store。
- 每个 Agent 图结束后对累计变更及依赖闭包做基础硬校验；通过才发布不可变预览代次。
- 主图自认为完成后统一验收；失败注入反馈让同一会话自纠。修复耗尽、停止或硬失败
  丢弃草稿，正式项目保持基线。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import uuid4

from narrative_forge.agents.execution_middleware import (
    WriteLeaseCoordinator,
    checkpoint_invalid_user_status,
    current_turn_workspace,
    current_write_lease,
)
from narrative_forge.agents.recursion_budget import recursion_config
from narrative_forge.core.playtest_context import PLAYTEST_NOTE_PREFIX
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.trace_context import (
    active_batch_step_id,
    budget_force_closed,
    budget_notices,
    nested_event_queue,
)
from narrative_forge.orchestrator.turn_control import (
    AgentTurnStopped,
    TurnStopController,
    current_turn_stop,
    STOP_POLL_INTERVAL,
)
from narrative_forge.orchestrator.trace_utils import (
    duration_ms,
    fragment_label,
    new_event_id,
    now_timestamp,
    serialize_trace_payload,
)
from narrative_forge.orchestrator.turn_validation import (
    capture_fragment_map,
    preview_targets,
    restore_fragments,
    validate_fragment_maps,
    _write_fragment,
)
from narrative_forge.orchestrator.turn_workspace import (
    TurnWorkspace,
    _bump_versions,
    snapshot_to_bundle,
)
from narrative_forge.core.validation import (
    reachability_warnings,
)

logger = logging.getLogger(__name__)

# data_type → Agent 侧虚拟路径（用于反馈消息中提示 Agent 改哪个文件）。
# 仅 JSON 片段需要回合末硬校验/修复反馈；outline 已是自由 Markdown 文本，不在此列。
_VPATH = {
    "world": "/project/world.json",
    "events": "/project/events.json",
    "intent": "/project/intent.md",
    "outline": "/project/outline.md",
}

# 注入给 Agent 的修复反馈消息前缀（只进模型上下文，不作为用户可见气泡）。
_FEEDBACK_PREFIX = "[系统校验]"

# 注入给 Agent 的确定性项目状态消息前缀；只进模型上下文，不转发 SSE。
_STATUS_PREFIX = "[系统状态]"

# 停止后下一轮注入给 Agent 的说明前缀；只进模型上下文，不作为用户可见气泡。
_STOPPED_REQUEST_PREFIX = "[系统说明]"

# 注入原请求时的最长字符数，避免超长粘贴撑爆下一轮上下文。
_STOPPED_REQUEST_TEXT_LIMIT = 4000

# 主 Agent 的名字（见 agents/main_agent.py）；用于按 ``lc_agent_name`` 区分主/子 Agent。
_MAIN_AGENT_NAME = "main-agent"


@dataclass
class TurnResult:
    """一个对话回合的结果。

    Attributes:
        text: 给用户看的最终助手回复文本。
        updated: 本轮校验通过并登记版本的片段，元素为 ``(data_type, revision)``。
        failed: 本轮仍不合法的片段，``{data_type: 错误说明}``。
        repairs: 实际触发的自动修复次数。
        partial: 是否因预算收口而只完成一部分。
        budget_closed: 是否由递归预算主动结束。
        completed_parts: 已正式登记的内容自然名称。
        remaining_parts: 未完成或已恢复基线的内容自然名称。
        committed: 是否已把合法变化写入正式项目。
        aborted: 是否因修复耗尽或无法闭合而丢弃本轮全部修改。
    """

    text: str
    updated: list[tuple[str, int]] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    repairs: int = 0
    partial: bool = False
    budget_closed: bool = False
    completed_parts: list[str] = field(default_factory=list)
    remaining_parts: list[str] = field(default_factory=list)
    committed: bool = True
    aborted: bool = False


@dataclass
class TurnEvent:
    """:meth:`ProjectSession.astream_turn` 产出的过程事件（供 API 转发到 SSE）。

    Attributes:
        type: 事件类型——
            ``"agent_text"``：任意 Agent 的可见文本增量；
            ``"tool_start"`` / ``"tool_end"``：工具或子 Agent 步骤（含输入/输出/耗时）；
            ``"budget_status"``：75/90 预算收口提示；
            ``"data_preview_published"``：检查点通过后冻结的不可变批量预览；
            ``"status"``：用户可见运行提示（须带 ``audience``）；
            ``"completed"``：回合结束（含最终回复、正式更新和部分完成字段）。
        data: 事件载荷，含 ``turn_id`` / ``sequence`` 等信封字段。
    """

    type: str
    data: dict


class ProjectSession:
    """绑定到某项目的对话会话（纯异步）。

    Args:
        store: 项目存储。
        project_id: 项目 id。
        agent: 预构建的 deep agent；缺省时按配置自动构建。
        max_repair: 校验失败时的最大自动修复次数（默认 1）。
        use_skills: 是否为 sub-agent 挂载 skills。
    """

    def __init__(
        self,
        store: ProjectStore,
        project_id: str,
        agent=None,
        max_repair: int = 1,
        use_skills: bool = True,
    ):
        self.store = store
        self.project_id = project_id
        self.max_repair = max_repair
        self.use_skills = use_skills
        self._injected_agent = agent is not None
        self.response_locale = "zh-CN"
        if agent is None:
            from narrative_forge.agents import build_main_agent

            agent = build_main_agent(
                project_id,
                store=store,
                use_skills=use_skills,
                locale=self.response_locale,
            )
        self.agent = agent
        self.messages: list = []
        self._turn_id = ""
        self._sequence = 0
        self._root_step_id: str | None = None
        self._tool_started_at: dict[str, float] = {}
        self._tool_inputs: dict[str, object] = {}
        self._stop_controller: TurnStopController | None = None
        self._stop_token = None
        self.workspace: TurnWorkspace | None = None
        self._content_baseline: dict[str, str | None] = {}
        self._checkpoint_map: dict[str, str | None] = {}
        self._preview_generation = 0
        self._lease: WriteLeaseCoordinator | None = None
        self._lease_token = None
        self._workspace_token = None

    def set_response_locale(self, locale: str | None) -> None:
        """为本轮设置自然语言回复语言。

        语言变化时重建未注入的 Agent，使 system prompt 与子 Agent 同步。
        注入的测试 Agent 不重建。

        Args:
            locale: 前端传入的语言标签。
        """
        from narrative_forge.agents.prompts import normalize_response_locale

        normalized = normalize_response_locale(locale)
        if normalized == self.response_locale:
            return
        self.response_locale = normalized
        if self._injected_agent:
            return
        from narrative_forge.agents import build_main_agent

        self.agent = build_main_agent(
            self.project_id,
            store=self.store,
            use_skills=self.use_skills,
            locale=normalized,
        )

    # ── 对外主入口 ──────────────────────────────────────────────────────────
    async def astream_turn(
        self,
        user_text: str,
        stop_controller: TurnStopController | None = None,
        turn_id: str | None = None,
        workspace: TurnWorkspace | None = None,
        lease: WriteLeaseCoordinator | None = None,
        playtest_note: str | None = None,
    ) -> AsyncIterator[TurnEvent]:
        """流式执行一个对话回合，逐步产出过程事件（含检查点预览与统一验收）。

        Args:
            user_text: 用户输入。
            stop_controller: 可选的本轮停止控制器；请求停止后跳过修复和正式收口。
            turn_id: 与 API 共享的回合 id；缺省时本层自行生成。
            workspace: 生产回合的草稿工作区；测试注入假 Agent 时可省略。
            lease: 可选写租约；缺省时本轮新建。
            playtest_note: 可选的 ``[系统试玩]`` 说明，只进本轮模型上下文。

        Yields:
            :class:`TurnEvent`：``text`` 正文增量、``tool_start`` / ``tool_end`` 工具步骤、
            ``status`` 状态提醒、``completed`` 回合结束。最终 :class:`TurnResult` 也会存在
            ``self.last_result`` 上。
        """
        message_origin = len(self.messages)
        self._begin_turn(
            turn_id=turn_id,
            stop_controller=stop_controller,
            workspace=workspace,
            lease=lease,
        )

        try:
            self._raise_if_stopped()
            self.messages.append({"role": "user", "content": user_text})
            stopped_note = self._stopped_request_note()
            if stopped_note:
                self.messages.append({"role": "user", "content": stopped_note})
            # 感知现状：注入快速数值/死路提示和完整检测状态（见 DESIGN §3.3/§4.2.1/§4.7）。
            status_note = self._build_status_note()
            if status_note:
                self.messages.append({"role": "user", "content": status_note})
            if playtest_note:
                self.messages.append({"role": "user", "content": playtest_note})

            yield self._root_start_event()

            repairs = 0
            budget_closed = False
            invalid: dict[str, str] = {}
            while True:
                self._raise_if_stopped()
                async for ev in self._astream_agent():
                    self._raise_if_stopped_between_tools()
                    yield ev
                self._raise_if_stopped()
                async for ev in self._publish_graph_checkpoint():
                    yield ev
                budget_closed = bool(getattr(self, "_last_budget_closed", False)) or budget_force_closed.get()
                invalid = self._validate_changed()
                # 预算主动收口后不再开新的自动修复 Agent，以免重新耗尽步数。
                if budget_closed or not invalid or repairs >= self.max_repair:
                    if invalid:
                        self._log_invalid(invalid, repairs, will_retry=False)
                    break
                self._log_invalid(invalid, repairs + 1, will_retry=True)
                self.messages.append({"role": "user", "content": _build_feedback(invalid)})
                repairs += 1

            self._raise_if_stopped()
            result = self._finalize(
                repairs,
                budget_closed=budget_closed,
                invalid=invalid,
            )
            self.last_result = result
            self._drop_playtest_notes()
            yield self._emit(
                "completed",
                {
                    "text": result.text,
                    "updated": [list(t) for t in result.updated],
                    "failed": result.failed,
                    "repairs": result.repairs,
                    "partial": result.partial,
                    "budget_closed": result.budget_closed,
                    "completed_parts": result.completed_parts,
                    "remaining_parts": result.remaining_parts,
                    "committed": result.committed,
                    "aborted": result.aborted,
                },
            )
            yield self._root_end_event()
        except AgentTurnStopped:
            self.messages = self.messages[:message_origin]
            raise
        except asyncio.CancelledError:
            self.messages = self.messages[:message_origin]
            if self._stop_controller is not None and self._stop_controller.is_stopped():
                raise AgentTurnStopped() from None
            raise
        except Exception:
            self.messages = self.messages[:message_origin]
            raise
        finally:
            self._end_turn()

    async def asend(self, user_text: str, playtest_note: str | None = None) -> TurnResult:
        """非流式执行一个对话回合，只返回最终 :class:`TurnResult`（CLI / 冒烟脚本用）。

        内部走 ``ainvoke``（不流式，最稳），与 :meth:`astream_turn` 共用校验/登记逻辑。
        """
        message_origin = len(self.messages)
        self._begin_turn()

        try:
            self.messages.append({"role": "user", "content": user_text})
            stopped_note = self._stopped_request_note()
            if stopped_note:
                self.messages.append({"role": "user", "content": stopped_note})
            status_note = self._build_status_note()
            if status_note:
                self.messages.append({"role": "user", "content": status_note})
            if playtest_note:
                self.messages.append({"role": "user", "content": playtest_note})
            self._raise_if_stopped()
            await self._arun_agent()

            repairs = 0
            budget_closed = bool(getattr(self, "_last_budget_closed", False)) or budget_force_closed.get()
            invalid: dict[str, str] = {}
            while True:
                self._raise_if_stopped()
                async for _ev in self._publish_graph_checkpoint():
                    pass
                invalid = self._validate_changed()
                if budget_closed or not invalid or repairs >= self.max_repair:
                    if invalid:
                        self._log_invalid(invalid, repairs, will_retry=False)
                    break
                self._log_invalid(invalid, repairs + 1, will_retry=True)
                self.messages.append({"role": "user", "content": _build_feedback(invalid)})
                await self._arun_agent()
                budget_closed = budget_closed or budget_force_closed.get()
                repairs += 1

            self._raise_if_stopped()
            result = self._finalize(
                repairs,
                budget_closed=budget_closed,
                invalid=invalid,
            )
            self._drop_playtest_notes()
            return result
        except AgentTurnStopped:
            self.messages = self.messages[:message_origin]
            raise
        except Exception:
            self.messages = self.messages[:message_origin]
            raise
        finally:
            self._end_turn()

    # ── Agent 调用（异步）──────────────────────────────────────────────────
    async def _arun_agent(self) -> None:
        """非流式跑一次 agent，并更新会话消息历史。"""
        result = await self.agent.ainvoke(
            {"messages": self.messages}, config=recursion_config()
        )
        self.messages = result["messages"]

    async def _astream_agent(self) -> AsyncIterator[TurnEvent]:
        """流式跑一次 agent：汇合主图事件与嵌套 worker/middleware 事件。

        主图用 ``astream_events(version="v2")``；批量情节等独立图通过
        :mod:`trace_context` 队列回灌，以便挂到当前父步骤下实时展示。
        """
        queue: asyncio.Queue = asyncio.Queue()
        queue_token = nested_event_queue.set(queue)
        notices_token = budget_notices.set(set())
        force_token = budget_force_closed.set(False)
        visible_tool_ids: set[str] = set()
        active_subagent_tasks: dict[str, str] = {}
        final_messages = None

        async def pump_parent() -> None:
            try:
                async for ev in self.agent.astream_events(
                    {"messages": self.messages},
                    version="v2",
                    config=recursion_config(),
                ):
                    await queue.put(("parent", ev))
            finally:
                await queue.put(("done", None))

        pump_task = asyncio.create_task(pump_parent())
        try:
            while True:
                controller = self._stop_controller
                if (
                    controller is not None
                    and controller.is_stopped()
                    and not controller.has_file_mutating_tools()
                ):
                    if not pump_task.done():
                        pump_task.cancel()
                    raise AgentTurnStopped()
                try:
                    kind, payload = await asyncio.wait_for(
                        queue.get(),
                        timeout=STOP_POLL_INTERVAL,
                    )
                except asyncio.TimeoutError:
                    continue
                if kind == "done":
                    break
                if kind == "nested":
                    if isinstance(payload, TurnEvent):
                        yield self._stamp(payload)
                    self._raise_if_stopped_between_tools()
                    continue
                async for event in self._map_langchain_event(
                    payload,
                    visible_tool_ids,
                    active_subagent_tasks,
                ):
                    if event.type == "_final_messages":
                        final_messages = event.data.get("messages")
                        continue
                    yield event
                    self._raise_if_stopped_between_tools()
            while not queue.empty():
                kind, payload = queue.get_nowait()
                if kind == "nested" and isinstance(payload, TurnEvent):
                    yield self._stamp(payload)
            if final_messages is not None:
                self.messages = final_messages
            self._last_budget_closed = budget_force_closed.get()
            self._raise_if_stopped_between_tools()
        except AgentTurnStopped:
            raise
        except asyncio.CancelledError:
            if self._stop_controller is not None and self._stop_controller.is_stopped():
                raise AgentTurnStopped() from None
            raise
        finally:
            nested_event_queue.reset(queue_token)
            budget_notices.reset(notices_token)
            budget_force_closed.reset(force_token)
            controller = self._stop_controller
            writing = controller is not None and controller.has_file_mutating_tools()
            if not pump_task.done() and not writing:
                pump_task.cancel()
            await self._finish_agent_pump(pump_task)

    async def _finish_agent_pump(self, pump_task: asyncio.Task) -> None:
        """主图协程收尾：正在写文件时等它结束；停止后不等待模型/子任务跑完。"""
        if pump_task.done():
            try:
                pump_task.result()
            except (asyncio.CancelledError, Exception):
                pass
            return
        controller = self._stop_controller
        wait_for_graph = (
            controller is None
            or not controller.is_stopped()
            or controller.has_file_mutating_tools()
        )
        try:
            if wait_for_graph:
                await pump_task
            else:
                await asyncio.wait_for(pump_task, timeout=STOP_POLL_INTERVAL)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            pass

    # ── 回合末：内容级验收 / 提交 / 放弃 ──────────────────────────────────────────
    @property
    def _work_store(self) -> ProjectStore:
        """本轮 Agent 实际写入的存储：有草稿时用草稿，否则用正式项目。"""
        if self.workspace is not None:
            return self.workspace.draft_store
        return self.store

    def _content_baseline_map(self) -> dict[str, str | None]:
        """回合开始时的内容基线。"""
        if self.workspace is not None:
            return self.workspace.baseline
        return self._content_baseline

    def _validate_changed(self) -> dict[str, str]:
        """按内容摘要比较基线与当前草稿，返回 ``{片段键: 错误}``。"""
        current = capture_fragment_map(self._work_store, self.project_id)
        report = validate_fragment_maps(self._content_baseline_map(), current)
        return report.as_invalid_map()

    async def _publish_graph_checkpoint(self) -> AsyncIterator[TurnEvent]:
        """主 Agent 图结束后发布检查点：仅当自上次检查点以来有合法变化。"""
        if self.workspace is not None and self.workspace.service is not None:
            snapshot = self.workspace.service.publish_checkpoint(
                self.workspace,
                step_id=self._root_step_id,
            )
            if snapshot is not None:
                yield self._emit(
                    "data_preview_published",
                    {
                        **snapshot_to_bundle(snapshot, turn_id=self.workspace.turn_id),
                        "step_id": self._root_step_id,
                        "source": "agent_preview",
                    },
                )
                return
            current = capture_fragment_map(self._work_store, self.project_id)
            report = validate_fragment_maps(self.workspace.checkpoint, current)
            if not report.ok:
                yield self._emit("status", checkpoint_invalid_user_status())
            return
        current = capture_fragment_map(self._work_store, self.project_id)
        report = validate_fragment_maps(self._checkpoint_map, current)
        if not report.ok:
            yield self._emit("status", checkpoint_invalid_user_status())
            return
        if not report.changed_keys and not report.deleted_keys:
            return
        self._preview_generation += 1
        self._checkpoint_map = current
        yield self._emit(
            "data_preview_published",
            {
                "turn_id": self._turn_id,
                "preview_generation": self._preview_generation,
                "targets": preview_targets(report.changed_keys, report.deleted_keys),
                "step_id": self._root_step_id,
                "source": "agent_preview",
            },
        )

    def _finalize(
        self,
        repairs: int,
        *,
        budget_closed: bool = False,
        invalid: dict[str, str] | None = None,
    ) -> TurnResult:
        """统一验收后提交合法变化，或在无法闭合时放弃本轮。"""
        invalid = invalid or {}
        current = capture_fragment_map(self._work_store, self.project_id)
        baseline = self._content_baseline_map()
        report = validate_fragment_maps(baseline, current)
        if report.ok:
            updated = self._commit_current(baseline, current, report.changed_keys, report.deleted_keys)
            return self._turn_result(
                updated,
                {},
                repairs,
                budget_closed=budget_closed,
                committed=True,
            )
        if budget_closed:
            candidate = self._closed_valid_candidate(baseline, current, report)
            if candidate is not None:
                kept = validate_fragment_maps(baseline, candidate)
                self._write_candidate(candidate)
                updated = self._commit_current(
                    baseline,
                    candidate,
                    kept.changed_keys,
                    kept.deleted_keys,
                )
                remaining = [
                    key for key in (*report.changed_keys, *report.deleted_keys)
                    if key not in kept.changed_keys and key not in kept.deleted_keys
                ]
                return self._turn_result(
                    updated,
                    {key: report.as_invalid_map().get(key, "未纳入收口") for key in remaining},
                    repairs,
                    budget_closed=True,
                    committed=True,
                    remaining_keys=remaining,
                )
        restore_fragments(self._work_store, self.project_id, baseline)
        text = _last_ai_text({"messages": self.messages})
        if "未采纳任何修改" not in text:
            text = f"{text}\n\n本轮修改未通过基础验收，未采纳任何修改。"
        return TurnResult(
            text=text,
            updated=[],
            failed=report.as_invalid_map() or invalid,
            repairs=repairs,
            partial=False,
            budget_closed=bool(budget_closed),
            completed_parts=[],
            remaining_parts=[fragment_label(key) for key in (*report.changed_keys, *report.deleted_keys, *invalid)],
            committed=False,
            aborted=True,
        )

    def _closed_valid_candidate(
        self,
        baseline: dict[str, str | None],
        current: dict[str, str | None],
        report,
    ) -> dict[str, str | None] | None:
        """预算收口：把非法片段恢复为基线，得到整体仍合法的保留集合。"""
        candidate = dict(current)
        for key in report.as_invalid_map():
            candidate[key] = baseline.get(key)
        kept = validate_fragment_maps(baseline, candidate)
        if not kept.ok:
            return None
        if not kept.changed_keys and not kept.deleted_keys:
            return None
        return candidate

    def _write_candidate(self, candidate: dict[str, str | None]) -> None:
        """把候选正文写回当前工作存储（草稿或正式项目）。"""
        current = capture_fragment_map(self._work_store, self.project_id)
        keys = set(current) | set(candidate)
        for key in keys:
            if current.get(key) == candidate.get(key):
                continue
            _write_fragment(self._work_store, self.project_id, key, candidate.get(key))

    def _commit_current(
        self,
        baseline: dict[str, str | None],
        current: dict[str, str | None],
        changed_keys: list[str],
        deleted_keys: list[str],
    ) -> list[tuple[str, int]]:
        """把当前合法内容写入正式项目并提升 revision。"""
        if self.workspace is not None and self.workspace.service is not None:
            result = self.workspace.service.commit(self.workspace)
            return result.updated
        from narrative_forge.orchestrator.turn_workspace import _apply_content

        _apply_content(self.store, self.project_id, baseline, current)
        return _bump_versions(self.store, self.project_id, changed_keys, deleted_keys)

    def _turn_result(
        self,
        updated: list[tuple[str, int]],
        failed: dict[str, str],
        repairs: int,
        *,
        budget_closed: bool,
        committed: bool,
        remaining_keys: list[str] | None = None,
    ) -> TurnResult:
        """组装回合结果。"""
        remaining = remaining_keys if remaining_keys is not None else list(failed)
        return TurnResult(
            text=_last_ai_text({"messages": self.messages}),
            updated=updated,
            failed=failed,
            repairs=repairs,
            partial=bool(budget_closed and remaining),
            budget_closed=bool(budget_closed),
            completed_parts=[fragment_label(dt) for dt, _rev in updated],
            remaining_parts=[fragment_label(key) for key in remaining],
            committed=committed,
            aborted=not committed,
        )

    def _message_text(self, message: object) -> str:
        """取出消息正文，兼容字典与 LangChain 消息对象。"""
        if isinstance(message, dict):
            return str(message.get("content") or "")
        content = getattr(message, "content", "")
        return content if isinstance(content, str) else str(content or "")

    def _drop_playtest_notes(self) -> None:
        """本轮结束后去掉试玩情景，避免下一轮把旧位置当成现状。"""
        self.messages = [
            message
            for message in self.messages
            if not self._message_text(message).startswith(PLAYTEST_NOTE_PREFIX)
        ]

    def _stopped_request_note(self) -> str | None:
        """若上一轮（或连续多轮）被用户停止，构造供 Agent 阅读的原请求说明。

        从展示用 ``chat.jsonl`` 读取，不恢复半截工具调用。说明只写入 Agent 上下文，
        调用方不得把它当作 SSE ``status`` 气泡转发给用户。
        """
        return build_stopped_request_note(
            recent_stopped_user_texts(self.store.get_chat(self.project_id))
        )

    def _build_status_note(self) -> str | None:
        """构造一条 ``[系统状态]`` 提醒消息供 Agent 感知（无内容时返回 ``None``）。

        汇总两类确定性或程序化状态：
        1. **数值可达性 warning**：事件边引用的 scalar 阈值"再乐观也够不到"（见 §4.2.1）。
        2. **完整检测状态**：提醒当前版本尚未重新检测，或已有可按需读取的当前正式报告。

        数值预检只在当前版本尚未完成正式传播时注入；正式报告存在时以报告为准。
        本消息只写入 Agent 上下文，调用方不得把它当作 SSE ``status`` 转发给用户。

        Returns:
            形如 ``[系统状态] ...`` 的提醒文本；当前无 warning 且无需提示检测状态时返回 ``None``。
        """
        validation = self.store.validation_state(self.project_id)
        report = validation.get("report") or {}
        propagation_ran = (report.get("meta") or {}).get("propagation_ran") is True
        reach = [] if propagation_ran else self._reachability_warnings()
        events_exist = self.store.data_file(self.project_id, "events").exists()
        validation_pending = events_exist and validation["status"] == "not_checked"
        validation_current = validation["status"] in {
            "incomplete",
            "failed",
            "passed",
        }
        if not reach and not validation_pending and not validation_current:
            return None

        lines: list[str] = [_STATUS_PREFIX]
        if reach:
            lines.append(
                "另检测到下列**数值门槛可能不可达**（按当前已生成情节快速估算，"
                "不是完整可玩性检测结果）。请复核对应事件边阈值或情节 effect 是否合理："
            )
            lines.extend(f"- {w['message']}" for w in reach)
        if validation_pending:
            lines.append(
                "当前事件或情节内容尚未运行完整可玩性检测。除非用户明确要求，否则不要自动运行；"
                "只需在本轮修改完成后提醒用户可按需检测。"
            )
        elif validation_current:
            summary = report.get("summary") or {}
            lines.append(
                "当前保存版本已有仍然有效的正式检测报告："
                f"状态 {validation['status']}，问题 {summary.get('issue_count', 0)} 项。"
                "用户提到最新检测结果或要求处理这些问题时，先调用 "
                "read_latest_state_validation；不要为了读取报告而重复运行检测。"
            )
        return "\n".join(lines)

    def _reachability_warnings(self) -> list[dict]:
        """跨层数值可达性软校验：汇总事件图 + 全部已生成场景图，估阈值可达性并落日志。

        委托给 :func:`reachability_warnings`（容错解析、绝不抛异常）；有 warning 时落一条
        WARNING 日志便于事后分析 Agent 常踩的数值平衡问题（见 DESIGN §4.2.1）。

        Returns:
            warning 项列表（``{"message", "edge_id", "var"}``）；无数据 / 无不可达阈值时为空。
        """
        events = self.store.get_data(self.project_id, "events")
        scenes = [
            s
            for eid in self.store.list_scene_event_ids(self.project_id)
            if isinstance(s := self.store.get_scene(self.project_id, eid), dict)
        ]
        warnings = reachability_warnings(events if isinstance(events, dict) else None, scenes)
        if warnings:
            logger.warning(
                "数值可达性软校验 · 项目=%s · %d 条不可达阈值 · %s",
                self.project_id,
                len(warnings),
                " | ".join(w["message"] for w in warnings),
            )
        return warnings

    def _log_invalid(self, invalid: dict[str, str], attempt: int, will_retry: bool) -> None:
        """把回合末校验失败的**原因**落日志，便于事后排查 Agent 常踩的约束。

        Args:
            invalid: ``{data_type: 错误说明}``（来自 :meth:`_validate_changed`）。
            attempt: 即将进行的修复序号（``will_retry`` 时有意义）。
            will_retry: 是否还会自动修复；False 表示已达上限、将放弃本轮修改。
        """
        action = (
            f"将触发第 {attempt} 次自动修复"
            if will_retry
            else "已达最大修复次数，将放弃本轮全部修改"
        )
        level = logging.WARNING if will_retry else logging.ERROR
        for dt, msg in invalid.items():
            # 多行错误压成单行，便于日志检索；项目/片段入参，方便定位。
            logger.log(
                level,
                "回合末校验失败 · 项目=%s 片段=%s · %s · 原因：%s",
                self.project_id,
                dt,
                action,
                " | ".join(msg.splitlines()),
            )

    def _begin_turn(
        self,
        turn_id: str | None = None,
        stop_controller: TurnStopController | None = None,
        workspace: TurnWorkspace | None = None,
        lease: WriteLeaseCoordinator | None = None,
    ) -> None:
        """为新回合准备轨迹信封、草稿绑定、写租约和停止控制器。"""
        self._turn_id = turn_id or uuid4().hex
        self._sequence = 0
        self._root_step_id = f"{self._turn_id}:root"
        self._tool_started_at = {}
        self._tool_inputs = {}
        self._stop_controller = stop_controller
        self._stop_token = current_turn_stop.set(stop_controller)
        self.workspace = workspace
        if workspace is not None and not self._injected_agent:
            from narrative_forge.agents import build_main_agent

            self.agent = build_main_agent(
                self.project_id,
                store=workspace.draft_store,
                use_skills=self.use_skills,
                locale=self.response_locale,
            )
        work = self._work_store
        self._content_baseline = (
            dict(workspace.baseline)
            if workspace is not None
            else capture_fragment_map(work, self.project_id)
        )
        self._checkpoint_map = dict(self._content_baseline)
        self._preview_generation = 0
        self._lease = lease or WriteLeaseCoordinator()
        self._lease_token = current_write_lease.set(self._lease)
        self._workspace_token = current_turn_workspace.set(workspace)
        budget_notices.set(set())
        budget_force_closed.set(False)

    def _end_turn(self) -> None:
        """清理回合级上下文，避免泄漏到下一轮。"""
        active_batch_step_id.set(None)
        budget_notices.set(None)
        budget_force_closed.set(False)
        self._reset_contextvar(current_turn_stop, "_stop_token")
        self._reset_contextvar(current_write_lease, "_lease_token")
        self._reset_contextvar(current_turn_workspace, "_workspace_token")
        self._stop_controller = None
        self._lease = None
        self.workspace = None
        self._tool_started_at.clear()
        self._tool_inputs.clear()

    def _reset_contextvar(self, var, token_attr: str) -> None:
        """重置 ContextVar；生成器被外层取消时 token 可能不属于当前上下文。"""
        token = getattr(self, token_attr, None)
        if token is None:
            return
        try:
            var.reset(token)
        except ValueError:
            pass
        setattr(self, token_attr, None)

    def _raise_if_stopped(self) -> None:
        """已请求停止且没有正在写文件时立即退出本轮。"""
        controller = self._stop_controller
        if controller is None:
            return
        if controller.is_stopped() and not controller.has_file_mutating_tools():
            raise AgentTurnStopped()

    def _raise_if_stopped_between_tools(self) -> None:
        """工具间隙检查停止；仅正在写文件时继续等待其原子替换结束。"""
        self._raise_if_stopped()

    def _stamp(self, event: TurnEvent) -> TurnEvent:
        """给已有过程事件补上 turn_id / sequence 信封。"""
        return self._emit(event.type, dict(event.data))

    def _emit(self, event_type: str, data: dict) -> TurnEvent:
        """构造带信封字段的过程事件。"""
        self._sequence += 1
        payload = dict(data)
        payload.setdefault("event_id", new_event_id())
        payload["turn_id"] = self._turn_id or payload.get("turn_id") or new_event_id()
        payload["sequence"] = self._sequence
        payload.setdefault("timestamp", now_timestamp())
        return TurnEvent(event_type, payload)

    def _root_start_event(self) -> TurnEvent:
        """本轮主 Agent 根步骤开始，主 Agent 自己的工具都挂在它下面。"""
        started = now_timestamp()
        if self._root_step_id:
            self._tool_started_at[self._root_step_id] = started
        return self._emit(
            "tool_start",
            {
                "tool": "main-agent",
                "agent": _MAIN_AGENT_NAME,
                "step_id": self._root_step_id,
                "parent_step_id": None,
                "label": "正在执行本轮任务",
                "done_label": "已完成本轮任务",
                "input": None,
                "started_at": started,
            },
        )

    def _root_end_event(self) -> TurnEvent:
        """本轮主 Agent 根步骤结束。"""
        return self._emit(
            "tool_end",
            {
                "tool": "main-agent",
                "agent": _MAIN_AGENT_NAME,
                "step_id": self._root_step_id,
                "output": None,
                "error": None,
                "duration_ms": duration_ms(
                    self._tool_started_at.get(self._root_step_id or "")
                ),
            },
        )

    async def _map_langchain_event(
        self,
        ev: dict,
        visible_tool_ids: set[str],
        active_subagent_tasks: dict[str, str],
    ) -> AsyncIterator[TurnEvent]:
        """把一条 LangChain v2 事件转成零个或多个面向前端的过程事件。"""
        etype = ev.get("event")
        data = ev.get("data") or {}
        agent_name = (ev.get("metadata") or {}).get("lc_agent_name")
        if etype == "on_chat_model_stream":
            text = _chunk_text(data.get("chunk"))
            if not text:
                return
            parent_step_id = self._agent_parent_step(agent_name, active_subagent_tasks)
            yield self._emit(
                "agent_text",
                {
                    "text": text,
                    "agent": agent_name or _MAIN_AGENT_NAME,
                    "step_id": parent_step_id,
                    "parent_step_id": parent_step_id,
                },
            )
            return
        if etype == "on_tool_start":
            step_id = _event_id(ev.get("run_id"))
            parent_step_id = _nearest_visible_parent(ev.get("parent_ids"), visible_tool_ids)
            tool_name = ev.get("name")
            tool_input = data.get("input")
            if parent_step_id is None and agent_name not in (None, _MAIN_AGENT_NAME):
                parent_step_id = _matching_subagent_parent(agent_name, active_subagent_tasks)
            if parent_step_id is None and self._root_step_id:
                parent_step_id = self._root_step_id
            if step_id is not None:
                visible_tool_ids.add(step_id)
                self._tool_started_at[step_id] = now_timestamp()
                self._tool_inputs[step_id] = tool_input
                if tool_name == "task" and isinstance(tool_input, dict):
                    subagent_type = tool_input.get("subagent_type")
                    if isinstance(subagent_type, str):
                        active_subagent_tasks[step_id] = subagent_type
            yield self._stamp(
                _tool_start_event(
                    tool_name,
                    tool_input,
                    step_id=step_id,
                    parent_step_id=parent_step_id,
                    agent_name=agent_name,
                    started_at=self._tool_started_at.get(step_id or ""),
                )
            )
            return
        if etype == "on_tool_end":
            step_id = _event_id(ev.get("run_id"))
            active_subagent_tasks.pop(step_id, None)
            output = data.get("output")
            error = _tool_error(output)
            yield self._emit(
                "tool_end",
                {
                    "tool": ev.get("name"),
                    "agent": agent_name or _MAIN_AGENT_NAME,
                    "step_id": step_id,
                    "output": None if error else serialize_trace_payload(output),
                    "error": error,
                    "duration_ms": duration_ms(self._tool_started_at.get(step_id or "")),
                },
            )
            return
        if etype == "on_chain_end" and not ev.get("parent_ids"):
            out = data.get("output")
            if isinstance(out, dict) and "messages" in out:
                yield TurnEvent("_final_messages", {"messages": out["messages"]})

    def _agent_parent_step(
        self,
        agent_name: str | None,
        active_subagent_tasks: dict[str, str],
    ) -> str | None:
        """模型文本挂到当前 Agent 对应的可见步骤上。"""
        if agent_name not in (None, _MAIN_AGENT_NAME):
            return (
                _matching_subagent_parent(agent_name, active_subagent_tasks)
                or self._root_step_id
            )
        return self._root_step_id


def _tool_error(output) -> str | None:
    """从工具结束载荷中提取错误说明；成功时返回 ``None``。"""
    if output is None:
        return None
    if isinstance(output, BaseException):
        return str(output)
    name = type(output).__name__
    if "Error" in name or "Exception" in name:
        return str(output)
    if isinstance(output, dict) and output.get("error"):
        return str(output.get("error"))
    return None


# 内置文件工具 → 面向用户的友好中文动作（避免暴露 read_file/write_file 这类技术名）。
_TOOL_LABELS = {
    "read_file": "正在阅读资料",
    "write_file": "正在撰写内容",
    "edit_file": "正在修改内容",
    "ls": "正在查看项目",
    "grep": "正在检索内容",
    "read_latest_state_validation": "正在读取最新检测结果",
    "run_state_validation": "正在运行完整检测",
    "generate_card_image": "正在生成卡片配图",
    "write_todos": "正在梳理步骤",
    "main-agent": "正在执行本轮任务",
}
_TOOL_DONE_LABELS = {
    "read_file": "已阅读资料",
    "write_file": "已撰写内容",
    "edit_file": "已修改内容",
    "ls": "已查看项目",
    "grep": "已检索内容",
    "read_latest_state_validation": "已读取最新检测结果",
    "run_state_validation": "已完成完整检测",
    "generate_card_image": "已生成卡片配图",
    "write_todos": "已梳理步骤",
    "main-agent": "已完成本轮任务",
}
# 子 Agent 类型 → 友好中文（用户视角，不暴露 outline-writer 这类内部代号）。
_SUBAGENT_LABELS = {
    "outline-writer": "正在撰写故事大纲",
    "world-builder": "正在构建世界设定",
    "event-builder": "正在设计事件图",
    "scene-builder": "正在设计场景情节",
}
_SUBAGENT_DONE_LABELS = {
    "outline-writer": "已完成故事大纲",
    "world-builder": "已完成世界设定",
    "event-builder": "已完成事件图",
    "scene-builder": "已完成场景情节",
}


def _event_id(value) -> str | None:
    """把 LangChain 事件调用 ID 转成可经 JSON/SSE 传输的字符串。

    Args:
        value: ``astream_events`` 的 ``run_id`` 或 ``parent_ids`` 元素。

    Returns:
        非空 ID 的字符串形式；缺失时返回 ``None``，供旧版/异常事件兼容降级。
    """
    return str(value) if value is not None else None


def _nearest_visible_parent(parent_ids, visible_tool_ids: set[str]) -> str | None:
    """从 Runnable 祖先链中找到最近的可见工具步骤。

    LangChain 的祖先链还包含图和模型等不展示节点，因此不能直接取最后一个
    ``parent_id``。从近到远查找已出现的工具调用，才能把子 Agent 内部操作挂到
    对应的 ``task`` 步骤下。

    Args:
        parent_ids: ``astream_events`` 提供的祖先调用 ID，顺序为由远到近。
        visible_tool_ids: 本次 Agent 流中已经发出 ``tool_start`` 的步骤 ID。

    Returns:
        最近可见父步骤的 ID；没有时返回 ``None``。
    """
    if not isinstance(parent_ids, (list, tuple)):
        return None
    for parent_id in reversed(parent_ids):
        candidate = _event_id(parent_id)
        if candidate in visible_tool_ids:
            return candidate
    return None


def _matching_subagent_parent(
    agent_name: str, active_subagent_tasks: dict[str, str]
) -> str | None:
    """按子 Agent 名称查找仍在运行的对应父任务。

    该函数只补偿框架事件缺失工具祖先链的情况，不按开始时间猜测。若同类型任务异常地同时存在，
    使用最近启动且仍活动的一项；项目级回合锁和 Agent 调度通常只会产生一个匹配项。

    Args:
        agent_name: LangChain 事件元数据中的 ``lc_agent_name``。
        active_subagent_tasks: ``task step_id`` 到 ``subagent_type`` 的活动任务映射。

    Returns:
        匹配父任务的步骤 ID；没有明确匹配时返回 ``None``。
    """
    for step_id, subagent_type in reversed(active_subagent_tasks.items()):
        if subagent_type == agent_name:
            return step_id
    return None


def _tool_start_event(
    tool_name: str | None,
    tool_input,
    *,
    step_id: str | None = None,
    parent_step_id: str | None = None,
    agent_name: str | None = None,
    started_at: float | None = None,
) -> TurnEvent:
    """把"某工具开始执行"转成 :class:`TurnEvent`，并附**面向用户的友好中文标签**。

    标签只用于前端步骤胶囊展示，不暴露内部工具名/子 Agent 代号；``tool`` 原始名仍保留
    在 data 里供调试。``task`` 工具额外标注派给了哪个子 Agent。

    Args:
        tool_name: LangChain 工具名。
        tool_input: 工具输入；``task`` 从中读取子 Agent 类型。
        step_id: 本次工具调用的唯一 ID。
        parent_step_id: 最近的可见父工具步骤 ID。
        agent_name: 发起调用的 Agent 名称。
        started_at: 开始时间戳。

    Returns:
        带友好标签、层级标识和截断输入的 ``tool_start`` 事件。
    """
    info: dict = {
        "tool": tool_name,
        "agent": agent_name or _MAIN_AGENT_NAME,
        "step_id": step_id,
        "parent_step_id": parent_step_id,
        "input": serialize_trace_payload(tool_input) if tool_input is not None else None,
        "started_at": started_at or now_timestamp(),
    }
    if tool_name == "task" and isinstance(tool_input, dict):
        sub = tool_input.get("subagent_type")
        info["subagent"] = sub
        info["label"] = _SUBAGENT_LABELS.get(sub, "正在执行子任务")
        info["done_label"] = _SUBAGENT_DONE_LABELS.get(sub, "已完成子任务")
    else:
        info["label"] = _TOOL_LABELS.get(tool_name or "", "正在处理")
        info["done_label"] = _TOOL_DONE_LABELS.get(tool_name or "", "已完成处理")
    return TurnEvent("tool_start", info)


def _chunk_text(msg_chunk) -> str:
    """从一个消息块中提取纯文本增量（content 可能是 str 或分块 list）。"""
    content = getattr(msg_chunk, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    return ""


def _build_feedback(invalid: dict[str, str]) -> str:
    """构造注入给 Agent 的修复反馈消息。"""
    lines = [
        f"{_FEEDBACK_PREFIX} 你刚写入的数据不符合规范，请用 read_file 读取对应文件后，"
        "用 edit_file 修正下列问题（保持其它内容不变），不要重写无关部分：",
    ]
    for dt, msg in invalid.items():
        if dt.startswith("scene:"):
            path = f"/project/scenes/{dt.split(':', 1)[1]}.json"
        else:
            path = _VPATH.get(dt, dt)
        lines.append(f"\n文件 {path}：\n{msg}")
    return "\n".join(lines)


def _last_ai_text(result: dict) -> str:
    """从 agent 返回状态中取最后一条 AI 文本回复。"""
    for msg in reversed(result.get("messages", [])):
        content = getattr(msg, "content", None)
        if getattr(msg, "type", None) == "ai" and content:
            if isinstance(content, list):
                return "".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in content
                )
            return str(content)
    return "（无文本回复）"


def recent_stopped_user_texts(chat: list[dict]) -> list[str]:
    """取出当前回合之前连续被停止的用户原文。

    Args:
        chat: ``chat.jsonl`` 消息列表。若最后一条已是本轮用户消息，则从它之前开始往回看。

    Returns:
        按时间顺序的被撤销请求原文；没有紧邻的停止回合时为空列表。
    """
    if not chat:
        return []
    index = len(chat) - 1
    if chat[index].get("role") == "user":
        index -= 1
    found: list[str] = []
    while index >= 1:
        assistant = chat[index]
        user = chat[index - 1]
        if assistant.get("role") != "assistant" or not assistant.get("stopped"):
            break
        if user.get("role") != "user":
            break
        text = str(user.get("text") or "").strip()
        if text:
            found.append(text)
        index -= 2
    found.reverse()
    return found


def build_stopped_request_note(requests: list[str]) -> str | None:
    """把被停止的原请求编成下一轮 Agent 可读的短说明。

    Args:
        requests: :func:`recent_stopped_user_texts` 的结果。

    Returns:
        以 ``[系统说明]`` 开头的说明；没有被停止请求时为 ``None``。
    """
    clipped = [_clip_stopped_request_text(text) for text in requests if str(text).strip()]
    if not clipped:
        return None
    if len(clipped) == 1:
        original = clipped[0]
        return (
            f"{_STOPPED_REQUEST_PREFIX} 上一轮用户请求已被停止，作品已回到该请求之前，"
            f"未保留任何修改。被撤销的原请求是：{original}。"
            "若用户要求重做、继续或按刚才的命令执行，按该原请求执行；"
            "不要把上一轮当作已完成的生成，也不要声称看不到上一条命令。"
        )
    numbered = "\n".join(
        f"{index}. {text}" for index, text in enumerate(clipped, start=1)
    )
    return (
        f"{_STOPPED_REQUEST_PREFIX} 最近连续 {len(clipped)} 轮用户请求均被停止，"
        "作品均已回到各请求之前，未保留任何修改。"
        f"被撤销的请求按时间顺序为：\n{numbered}\n"
        "若用户要求重做、继续或按刚才的命令执行，按这些原请求执行"
        "（具体创作要求以最早那条为准）；不要把已停止的回合当作已完成的生成，"
        "也不要声称看不到上一条命令。"
    )


def _clip_stopped_request_text(text: str) -> str:
    """过长原请求截断，保留前部以便下一轮仍能识别要重做的任务。"""
    compact = " ".join(str(text).split())
    if len(compact) <= _STOPPED_REQUEST_TEXT_LIMIT:
        return compact
    return compact[:_STOPPED_REQUEST_TEXT_LIMIT] + "…（原文已截断）"
