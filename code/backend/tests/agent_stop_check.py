"""离线检查：Agent 回合协作式停止、竞态、整轮回滚与草稿丢弃。

不调用 LLM。覆盖停止 API、运行注册表、模型/出图请求立即取消、用户中止回滚、回滚失败提示、权限与
停止后草稿不进入正式项目。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from narrative_forge.api.runtime import AgentTurnRunRegistry
from narrative_forge.agents.turn_control_middleware import TurnControlMiddleware
from narrative_forge.orchestrator.turn_control import (
    AgentTurnStopped,
    TurnStopController,
    current_turn_stop,
)
from narrative_forge.core.agent_changeset_service import AgentChangesetService
from narrative_forge.core.store import ProjectStore
from narrative_forge.api.routes import _run_turn
from narrative_forge.api.runtime import EventBus, ProjectLocks
from narrative_forge.orchestrator import TurnEvent


def _expect(condition: bool, message: str) -> None:
    """断言条件成立并打印结果。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


def _registry_race_check() -> None:
    """第一次停止获胜；completing 之后停止被拒绝。"""
    registry = AgentTurnRunRegistry()
    controller = TurnStopController("turn-a")
    begun = registry.begin("proj", "turn-a", controller)
    _expect(begun is not None and begun.status == "running", "登记 running 回合")
    first, payload = registry.request_stop("proj")
    _expect(first == "accepted" and payload["status"] == "stop_requested", "第一次停止被接受")
    second, again = registry.request_stop("proj")
    _expect(second == "idempotent" and again["turn_id"] == "turn-a", "重复停止幂等")
    _expect(not registry.mark_completing("proj", "turn-a"), "停止已获胜时不能进入 completing")

    registry2 = AgentTurnRunRegistry()
    controller2 = TurnStopController("turn-b")
    registry2.begin("proj", "turn-b", controller2)
    _expect(registry2.mark_completing("proj", "turn-b"), "正常收口可进入 completing")
    outcome, _ = registry2.request_stop("proj")
    _expect(outcome == "completing", "completing 后停止失败")


def _middleware_check() -> None:
    """停止后不再启动新工具；已开始的工具会跑完再抛停止。"""
    middleware = TurnControlMiddleware()
    controller = TurnStopController("turn-mw")
    token = current_turn_stop.set(controller)
    started = {"ran": False}
    try:
        controller.request_stop()
        raised = False
        try:
            middleware.wrap_tool_call(
                SimpleNamespace(tool_call={"name": "write_file"}),
                lambda _req: started.__setitem__("ran", True),
            )
        except AgentTurnStopped:
            raised = True
        _expect(raised and not started["ran"], "停止后新工具不执行")

        controller2 = TurnStopController("turn-mw-2")
        current_turn_stop.set(controller2)
        def handler(_req):
            controller2.request_stop()
            started["ran"] = True
            return "ok"

        raised = False
        try:
            middleware.wrap_tool_call(
                SimpleNamespace(tool_call={"name": "edit_file"}),
                handler,
            )
        except AgentTurnStopped:
            raised = True
        _expect(raised and started["ran"], "已开始的写文件工具会执行完再停止")

        controller3 = TurnStopController("turn-mw-3")
        current_turn_stop.set(controller3)

        async def slow_task(_req):
            await asyncio.sleep(3)
            return "done"

        async def abort_task() -> None:
            task = asyncio.create_task(
                middleware.awrap_tool_call(
                    SimpleNamespace(tool_call={"name": "task"}),
                    slow_task,
                )
            )
            await asyncio.sleep(0.12)
            controller3.request_stop()
            raised_task = False
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except AgentTurnStopped:
                raised_task = True
            except TimeoutError:
                task.cancel()
            _expect(raised_task, "子 Agent task 在停止后被取消")

        asyncio.run(abort_task())

        controller4 = TurnStopController("turn-mw-4")
        current_turn_stop.set(controller4)

        async def stubborn_task(_req):
            try:
                await asyncio.sleep(3)
            except asyncio.CancelledError:
                await asyncio.sleep(3)
            return "done"

        async def abort_stubborn() -> None:
            task = asyncio.create_task(
                middleware.awrap_tool_call(
                    SimpleNamespace(tool_call={"name": "task"}),
                    stubborn_task,
                )
            )
            await asyncio.sleep(0.12)
            controller4.request_stop()
            raised_task = False
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except AgentTurnStopped:
                raised_task = True
            except TimeoutError:
                task.cancel()
            _expect(raised_task, "子 Agent 取消后不等待其协程自然结束")

        asyncio.run(abort_stubborn())

        controller5 = TurnStopController("turn-mw-5")
        current_turn_stop.set(controller5)
        finished_sync = {"done": False}

        def slow_sync_task(_req):
            time.sleep(3)
            finished_sync["done"] = True
            return "done"

        def abort_sync() -> None:
            raised_sync = False
            stopper = threading.Timer(0.12, controller5.request_stop)
            stopper.start()
            try:
                middleware.wrap_tool_call(
                    SimpleNamespace(tool_call={"name": "task"}),
                    slow_sync_task,
                )
            except AgentTurnStopped:
                raised_sync = True
            stopper.cancel()
            _expect(raised_sync, "同步 task 在停止后立即退出")
            _expect(not finished_sync["done"], "不等待同步子任务跑完")

        abort_sync()
    finally:
        current_turn_stop.reset(token)


def _model_call_abort_check() -> None:
    """停止后取消进行中的模型调用，不等整段输出。"""
    middleware = TurnControlMiddleware()
    controller = TurnStopController("turn-model")
    token = current_turn_stop.set(controller)
    finished = {"done": False}

    async def slow_handler(_req):
        await asyncio.sleep(3)
        finished["done"] = True
        return "done"

    async def run() -> None:
        task = asyncio.create_task(
            middleware.awrap_model_call(SimpleNamespace(), slow_handler)
        )
        await asyncio.sleep(0.12)
        controller.request_stop()
        raised = False
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except AgentTurnStopped:
            raised = True
        except TimeoutError:
            task.cancel()
        _expect(raised, "模型调用在停止后被取消")
        _expect(not finished["done"], "未等到模型整段输出")

    try:
        asyncio.run(run())
    finally:
        current_turn_stop.reset(token)


def _image_request_abort_check(workspace: Path) -> None:
    """出图 HTTP 在落盘前可取消。"""
    from types import SimpleNamespace

    from narrative_forge.core.card_image_service import (
        CardImageCancelled,
        agenerate_card_image_asset,
    )

    store = ProjectStore(workspace)
    project = store.create_project("出图取消")
    cancel = threading.Event()
    finished = {"done": False}

    class _SlowImages:
        async def generate(self, **kwargs):
            del kwargs
            await asyncio.sleep(3)
            finished["done"] = True
            return SimpleNamespace(data=[SimpleNamespace(b64_json="not-used")])

    class _SlowClient:
        def __init__(self):
            self.images = _SlowImages()

        async def close(self):
            return None

    async def run() -> None:
        task = asyncio.create_task(
            agenerate_card_image_asset(
                store,
                project.id,
                category="characters",
                name="测试角色",
                image_client=_SlowClient(),
                cancel_event=cancel,
            )
        )
        await asyncio.sleep(0.12)
        cancel.set()
        raised = False
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except CardImageCancelled:
            raised = True
        except TimeoutError:
            task.cancel()
        _expect(raised, "出图 HTTP 在落盘前取消")
        _expect(not finished["done"], "未等到出图请求返回")
        leftover = (
            list(store.assets_dir(project.id).iterdir())
            if store.assets_dir(project.id).exists()
            else []
        )
        _expect(leftover == [], "取消出图不写入 assets")

    with patch.dict(
        os.environ,
        {
            "IMAGE_MODEL": "test-image",
            "IMAGE_SIZE": "1024x1024",
            "IMAGE_CHARACTER_MODEL": "test-image",
            "IMAGE_CHARACTER_SIZE": "1024x1024",
            "IMAGE_CHARACTER_BACKGROUND": "opaque",
        },
    ):
        asyncio.run(run())


def _session_pump_abort_check(workspace: Path) -> None:
    """没有活动文件工具时，事件泵不等下一个模型事件。"""
    from narrative_forge.orchestrator.session import ProjectSession

    class _SlowAgent:
        async def astream_events(self, inputs, version, config):
            del inputs, version, config
            await asyncio.sleep(3)
            if False:
                yield {}

    class _StubbornAgent:
        async def astream_events(self, inputs, version, config):
            del inputs, version, config
            try:
                await asyncio.sleep(3)
            except asyncio.CancelledError:
                await asyncio.sleep(3)
            if False:
                yield {}

    store = ProjectStore(workspace)
    project = store.create_project("事件泵停止")
    session = ProjectSession(store, project.id, agent=_SlowAgent(), max_repair=0)
    controller = TurnStopController("pump-turn")

    async def run() -> None:
        session._begin_turn(turn_id="pump-turn", stop_controller=controller)
        try:
            async def consume():
                async for _event in session._astream_agent():
                    pass

            task = asyncio.create_task(consume())
            await asyncio.sleep(0.12)
            controller.request_stop()
            raised = False
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except AgentTurnStopped:
                raised = True
            except TimeoutError:
                task.cancel()
            _expect(raised, "无工具活动时事件泵立即因停止退出")
        finally:
            session._end_turn()

    asyncio.run(run())

    stubborn_session = ProjectSession(
        store, project.id, agent=_StubbornAgent(), max_repair=0
    )
    stubborn_controller = TurnStopController("pump-stubborn")

    async def run_stubborn() -> None:
        stubborn_session._begin_turn(
            turn_id="pump-stubborn",
            stop_controller=stubborn_controller,
        )
        try:
            async def consume():
                async for _event in stubborn_session._astream_agent():
                    pass

            task = asyncio.create_task(consume())
            await asyncio.sleep(0.12)
            stubborn_controller.request_stop()
            raised = False
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except AgentTurnStopped:
                raised = True
            except TimeoutError:
                task.cancel()
            _expect(raised, "主图取消后事件泵不等待其自然结束")
        finally:
            stubborn_session._end_turn()

    asyncio.run(run_stubborn())


class _StopAfterWriteSession:
    """写入意图后等待停止标志，再抛出用户停止。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id
        self.wrote = asyncio.Event()

    async def astream_turn(self, message: str, stop_controller=None, turn_id=None, **_kwargs):
        """先写盘，再协作等待停止。"""
        del message, turn_id
        self.store.set_text(self.project_id, "intent", "停止后不应保留")
        self.wrote.set()
        for _ in range(200):
            if stop_controller is not None and stop_controller.is_stopped():
                break
            await asyncio.sleep(0.01)
        yield TurnEvent(
            "tool_start",
            {"tool": "write_file", "step_id": "w1", "label": "正在撰写内容"},
        )
        raise AgentTurnStopped()


class _CompleteThenRaceSession:
    """正常产出 completed，用于验证停止与完成竞态。"""

    def __init__(self, store: ProjectStore, project_id: str, hold: asyncio.Event):
        self.store = store
        self.project_id = project_id
        self.hold = hold

    async def astream_turn(self, message: str, **_kwargs):
        """等待测试方决定后再发出完成事件。"""
        del message
        self.store.set_text(self.project_id, "intent", "竞态写入")
        revision = self.store.bump_revision(self.project_id, "intent")
        await self.hold.wait()
        yield TurnEvent(
            "completed",
            {
                "text": "完成",
                "updated": [["intent", revision]],
                "failed": {},
                "repairs": 0,
            },
        )


def _api_stop_flow_check(workspace: Path) -> None:
    """通过 FastAPI 触发停止：保留用户消息、回滚内容、幂等、409。"""
    os.environ["NARRATIVE_FORGE_WORKSPACE"] = str(workspace)
    from narrative_forge.api.app import create_app

    app = create_app()
    store: ProjectStore = app.state.store
    project = store.create_project("停止 API")
    store.set_text(project.id, "intent", "基线意图")
    baseline_rev = store.bump_revision(project.id, "intent")
    session = _StopAfterWriteSession(store, project.id)
    app.state.sessions.get = lambda _pid: session

    with TestClient(app) as client:
        idle = client.post(f"/api/projects/{project.id}/chat/stop")
        _expect(idle.status_code == 409, "无运行回合停止返回 409")
        started = client.post(
            f"/api/projects/{project.id}/chat",
            json={"message": "请改意图"},
        )
        _expect(started.status_code == 202 and started.json().get("turn_id"), "POST /chat 返回 turn_id")
        run_now = client.get(f"/api/projects/{project.id}/chat/run").json()
        _expect(
            run_now.get("turn_id") == started.json().get("turn_id")
            and run_now.get("status") == "running",
            "POST 202 后立即 GET /chat/run 为同一 running 回合",
        )
        deadline = time.time() + 3
        while time.time() < deadline and not session.wrote.is_set():
            time.sleep(0.02)
        _expect(session.wrote.is_set(), "停止前 Agent 已写入预览内容")
        first = client.post(f"/api/projects/{project.id}/chat/stop")
        _expect(first.status_code == 200 and first.json()["status"] == "stop_requested", "停止请求被接受")
        second = client.post(f"/api/projects/{project.id}/chat/stop")
        _expect(second.status_code == 200, "重复停止幂等成功")
        deadline = time.time() + 5
        while time.time() < deadline:
            if not client.get(f"/api/projects/{project.id}").json().get("busy"):
                break
            time.sleep(0.05)
        _expect(
            not client.get(f"/api/projects/{project.id}").json().get("busy"),
            "停止后项目锁释放",
        )
        _expect(store.get_text(project.id, "intent") == "基线意图", "内容回到回合前")
        _expect(store.load_meta(project.id).revisions["intent"] == baseline_rev, "revision 回到回合前")
        history = store.get_chat(project.id)
        _expect(history[0]["role"] == "user", "用户消息保留")
        _expect(history[-1].get("stopped") is True, "助手停止记录落盘")
        _expect(AgentChangesetService(store).latest(project.id) is None, "停止后无 changeset")
        run = client.get(f"/api/projects/{project.id}/chat/run").json()
        _expect(run["status"] == "stopped", "运行状态为 stopped")


def _message_content(message) -> str:
    """读取注入给 Agent 的消息正文。"""
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


def _stopped_request_context_check(workspace: Path) -> None:
    """停止后下一轮 Agent 能读到被撤销的原请求，且说明不作为用户可见状态条。"""
    from narrative_forge.orchestrator.session import (
        ProjectSession,
        build_stopped_request_note,
        recent_stopped_user_texts,
    )

    original = "请生成一个西方魔法世界幻想故事大纲，包含 3 到 5 个阶段"
    redo = "我刚刚手误撤销了，重新执行下我刚刚的命令吧"
    chat = [
        {"role": "user", "text": original},
        {"role": "assistant", "text": "已停止，本轮修改均未保留", "stopped": True},
        {"role": "user", "text": redo},
    ]
    found = recent_stopped_user_texts(chat)
    _expect(found == [original], "从对话记录取出被停止的原请求")
    note = build_stopped_request_note(found) or ""
    _expect(original in note and "未保留" in note, "说明含原请求且标明未完成")
    _expect(
        recent_stopped_user_texts(
            [
                {"role": "user", "text": original},
                {"role": "assistant", "text": "完成", "stopped": False},
                {"role": "user", "text": redo},
            ]
        )
        == [],
        "成功回合之后不再注入停止说明",
    )
    chained = recent_stopped_user_texts(
        [
            {"role": "user", "text": original},
            {"role": "assistant", "text": "已停止", "stopped": True},
            {"role": "user", "text": "重新执行刚刚的命令"},
            {"role": "assistant", "text": "已停止", "stopped": True},
            {"role": "user", "text": "再试一次"},
        ]
    )
    _expect(
        chained == [original, "重新执行刚刚的命令"],
        "连续停止保留更早的具体创作请求",
    )

    store = ProjectStore(workspace)
    project = store.create_project("停止后重做")
    store.append_chat(project.id, {"role": "user", "text": original})
    store.append_chat(
        project.id,
        {
            "role": "assistant",
            "text": "已停止，本轮修改均未保留",
            "stopped": True,
            "steps": [],
        },
    )
    store.append_chat(project.id, {"role": "user", "text": redo})
    seen: dict[str, list] = {"messages": []}

    class _CaptureAgent:
        """记录主 Agent 实际收到的消息，不调用 LLM。"""

        async def astream_events(self, inputs, version, config):
            del version, config
            seen["messages"] = list(inputs.get("messages") or [])
            return
            yield

    session = ProjectSession(store, project.id, agent=_CaptureAgent(), max_repair=0)

    async def run_turn() -> list:
        return [
            event
            async for event in session.astream_turn(redo)
        ]

    events = asyncio.run(run_turn())
    injected = "\n".join(_message_content(message) for message in seen["messages"])
    _expect(original in injected, "下一轮 Agent 上下文含被撤销的原请求")
    _expect("[系统说明]" in injected, "下一轮注入系统说明前缀")
    status_texts = [
        str(event.data.get("text") or "")
        for event in events
        if event.type == "status"
    ]
    _expect(
        all("[系统说明]" not in text for text in status_texts),
        "停止说明不作为用户可见状态条",
    )


def _rollback_failure_message_check(workspace: Path) -> None:
    """回滚失败时不得显示“均未保留”。"""

    class BrokenChangesets:
        """假装基线恢复失败。"""

        def restore_to_baseline(self, *_args, **_kwargs):
            raise RuntimeError("无法写入基线")

    async def run() -> None:
        store = ProjectStore(workspace)
        project = store.create_project("回滚失败提示")
        bus = EventBus()
        locks = ProjectLocks()
        await locks.acquire(project.id)
        session = _StopAfterWriteSession(store, project.id)
        await _run_turn(
            store,
            bus,
            locks,
            session,
            project.id,
            "请修改",
            turn_id="turn-fail-restore",
            changesets=BrokenChangesets(),
            changeset_baseline={},
        )
        history = store.get_chat(project.id)
        text = history[-1].get("text") or ""
        _expect("均未保留" not in text, "回滚失败不虚假提示均未保留")
        _expect("恢复回合前内容失败" in text, "回滚失败给出检查提示")

    asyncio.run(run())


def _complete_vs_stop_race_check(workspace: Path) -> None:
    """停止 API 已接受时，随后的 completed 不得生成 changeset。"""

    async def run() -> None:
        store = ProjectStore(workspace)
        changesets = AgentChangesetService(store)
        project = store.create_project("停止完成竞态")
        store.set_text(project.id, "intent", "基线")
        store.bump_revision(project.id, "intent")
        bus = EventBus()
        locks = ProjectLocks()
        hold = asyncio.Event()
        session = _CompleteThenRaceSession(store, project.id, hold)
        registry = AgentTurnRunRegistry()
        controller = TurnStopController("race-turn")
        registry.begin(project.id, "race-turn", controller)
        baseline = changesets.capture_baseline(project.id)
        await locks.acquire(project.id)
        task = asyncio.create_task(
            _run_turn(
                store,
                bus,
                locks,
                session,
                project.id,
                "请修改",
                turn_id="race-turn",
                changesets=changesets,
                changeset_baseline=baseline,
                turn_runs=registry,
                stop_controller=controller,
            )
        )
        await asyncio.sleep(0.05)
        outcome, _ = registry.request_stop(project.id)
        _expect(outcome == "accepted", "竞态中停止先被接受")
        hold.set()
        await task
        _expect(store.get_text(project.id, "intent") == "基线", "停止获胜后内容回滚")
        _expect(changesets.latest(project.id) is None, "停止获胜后无 changeset")

    asyncio.run(run())


def _batch_stop_check(workspace: Path) -> None:
    """停止后丢弃草稿；正式项目保持基线，废弃批次工具不再写文件。"""
    from narrative_forge.agents.scene_batch_tool import build_scene_batch_tool
    from narrative_forge.orchestrator.turn_workspace import TurnWorkspaceService

    store = ProjectStore(workspace)
    project = store.create_project("批次停止")
    store.set_text(project.id, "intent", "基线意图")
    service = TurnWorkspaceService(store)
    turn = service.begin(project.id, "stop-draft")
    turn.draft_store.set_text(project.id, "intent", "草稿意图")
    service.publish_checkpoint(turn, step_id="root")
    revoked = service.abort(turn)
    _expect(bool(revoked), "停止撤销已发布的预览代次")
    _expect(store.get_text(project.id, "intent") == "基线意图", "停止后正式项目保持基线")
    _expect(not turn.draft_dir.exists(), "停止后草稿目录被删除")

    tool = build_scene_batch_tool(store, project.id, model=object())
    result = asyncio.run(tool.ainvoke({"event_ids": ["start"], "request": "生成"}))
    _expect("已停用" in str(result), "废弃批次工具不再启动 worker")
    _expect(store.get_text(project.id, "intent") == "基线意图", "废弃批次工具不写入项目")


def _cancel_revokes_preview_check(workspace: Path) -> None:
    """框架取消已发布预览时必须先 preview_revoked 再 turn_end，并清掉工作区。"""
    from narrative_forge.orchestrator.turn_workspace import TurnWorkspaceService

    store = ProjectStore(workspace)
    project = store.create_project("框架取消")
    store.set_text(project.id, "intent", "基线")
    workspaces = TurnWorkspaceService(store)
    bus = EventBus()
    locks = ProjectLocks()
    queue = bus.subscribe(project.id)
    published = asyncio.Event()

    class _PreviewThenHangSession:
        async def astream_turn(self, message, workspace=None, **_kwargs):
            del message
            if workspace is not None:
                workspace.draft_store.set_text(workspace.project_id, "intent", "取消前预览")
                snapshot = workspace.service.publish_checkpoint(workspace, step_id="root")
                yield TurnEvent(
                    "data_preview_published",
                    {
                        "turn_id": workspace.turn_id,
                        "preview_generation": snapshot.generation,
                    },
                )
            published.set()
            await asyncio.sleep(30)
            yield TurnEvent(
                "completed",
                {"text": "done", "updated": [], "failed": {}, "repairs": 0, "committed": True},
            )

    async def run() -> None:
        await locks.acquire(project.id)
        workspaces.begin(project.id, "cancel-turn")
        task = asyncio.create_task(
            _run_turn(
                store,
                bus,
                locks,
                _PreviewThenHangSession(),
                project.id,
                "写预览",
                turn_id="cancel-turn",
                workspaces=workspaces,
            )
        )
        await asyncio.wait_for(published.wait(), timeout=2)
        task.cancel()
        raised = False
        try:
            await task
        except asyncio.CancelledError:
            raised = True
        _expect(raised, "框架取消以 CancelledError 结束")
        types = []
        while not queue.empty():
            types.append(queue.get_nowait()["type"])
        _expect("preview_revoked" in types, "取消先广播 preview_revoked")
        _expect("turn_end" in types, "finally 仍发布 turn_end")
        _expect(
            types.index("preview_revoked") < types.index("turn_end"),
            "preview_revoked 早于 turn_end",
        )
        _expect(workspaces.get(project.id, "cancel-turn") is None, "取消后 drop workspace")
        _expect(not locks.is_busy(project.id), "取消后释放项目锁")

    asyncio.run(run())


def _permission_check(workspace: Path) -> None:
    """只读演示项目不能启动停止操作。"""
    os.environ["NARRATIVE_FORGE_WORKSPACE"] = str(workspace)
    from narrative_forge.api.app import create_app

    app = create_app()
    with TestClient(app) as client:
        demo = client.get("/api/quick-start/demo").json()
        blocked = client.post(f"/api/projects/{demo['project_id']}/chat/stop")
        _expect(blocked.status_code == 423, "演示项目不允许停止")


def main() -> int:
    """创建临时工作区、运行全部停止检查并清理。"""
    workspace = Path(tempfile.mkdtemp(prefix="nf_agent_stop_"))
    print("── Agent 停止并整轮撤销检查")
    try:
        _registry_race_check()
        _middleware_check()
        _model_call_abort_check()
        _image_request_abort_check(workspace / "image_abort")
        _session_pump_abort_check(workspace / "pump")
        _api_stop_flow_check(workspace / "api")
        _rollback_failure_message_check(workspace / "restore_fail")
        _complete_vs_stop_race_check(workspace / "race")
        _batch_stop_check(workspace / "batch")
        _cancel_revokes_preview_check(workspace / "cancel")
        _permission_check(workspace / "acl")
        _stopped_request_context_check(workspace / "redo")
        print("==== 结果 ====\n全部通过 ✅")
        return 0
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
