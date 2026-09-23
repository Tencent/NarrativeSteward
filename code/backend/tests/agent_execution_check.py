"""离线检查：写租约串行、权限拒绝、内容级验收与删除检测。

不调用真实 LLM。验证同一时刻只有一个写身份、受保护路径无法经文件工具改写，
以及 mtime 不再作为正式变更依据。
"""

from __future__ import annotations

import asyncio
import contextvars
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from narrative_forge.agents.backends import AtomicFilesystemBackend
from narrative_forge.agents.execution_middleware import WriteLeaseCoordinator, current_write_lease
from narrative_forge.agents.turn_control_middleware import TurnControlMiddleware
from narrative_forge.core.models.state_validation import ENGINE_VERSION, REPORT_SCHEMA_VERSION
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.session import ProjectSession
from narrative_forge.orchestrator.turn_control import TurnStopController, current_turn_stop
from narrative_forge.orchestrator.turn_validation import (
    capture_fragment_map,
    diff_fragment_maps,
    validate_fragment_maps,
)
from narrative_forge.orchestrator.turn_workspace import TurnWorkspaceService


def _expect(condition: bool, message: str) -> None:
    """断言条件成立；失败则退出。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


async def _lease_serial_check() -> None:
    """两个并发租约的持有时间不得重叠；同一调用链可重入。"""
    coordinator = WriteLeaseCoordinator()
    intervals: list[tuple[float, float]] = []

    async def hold(delay: float) -> None:
        async with coordinator.hold_async():
            started = asyncio.get_event_loop().time()
            async with coordinator.hold_async():
                await asyncio.sleep(delay)
            ended = asyncio.get_event_loop().time()
            intervals.append((started, ended))

    await asyncio.gather(hold(0.05), hold(0.05))
    first, second = sorted(intervals)
    _expect(first[1] <= second[0] + 1e-6, "两个写租约的执行时间区间不重叠")
    _expect(True, "同一调用链可重入持有写租约")


def _permission_check(root: Path) -> None:
    """创作文件可写，元数据/素材/检测记录不可写。"""
    root.mkdir(parents=True, exist_ok=True)
    backend = AtomicFilesystemBackend(root_dir=str(root), virtual_mode=True)
    (root / "intent.md").write_text("旧", encoding="utf-8")
    ok = backend.edit("/intent.md", "旧", "新")
    _expect(ok.error is None, "允许修改创作意图")
    denied_meta = backend.write("/meta.json", "{}")
    _expect(denied_meta.error is not None, "拒绝写入 meta.json")
    (root / "materials").mkdir()
    denied_material = backend.write("/materials/a.txt", "x")
    _expect(denied_material.error is not None, "拒绝写入素材目录")
    (root / "validation").mkdir()
    denied_validation = backend.write("/validation/latest.json", "{}")
    _expect(denied_validation.error is not None, "拒绝写入检测记录")


def _content_diff_check(workspace: Path) -> None:
    """内容相同但 mtime 不同不算变更；mtime 未变但内容变了要检出。"""
    store = ProjectStore(workspace)
    project = store.create_project("内容差分")
    store.set_text(project.id, "intent", "同一段话")
    before = capture_fragment_map(store, project.id)
    path = store.text_file(project.id, "intent")
    path.write_text("同一段话", encoding="utf-8")
    after_same = capture_fragment_map(store, project.id)
    changed, _added, deleted = diff_fragment_maps(before, after_same)
    _expect(not changed and not deleted, "内容相同即使 mtime 变化也不算修改")
    path.write_text("另一段话", encoding="utf-8")
    after_edit = capture_fragment_map(store, project.id)
    changed, _added, deleted = diff_fragment_maps(before, after_edit)
    _expect(changed == ["intent"] and not deleted, "内容变化即使可能 mtime 相近也要检出")


def _delete_and_cross_layer_check(workspace: Path) -> None:
    """删除 scene 是一等变化；改 world 导致未改 scene 引用失效时必须报错。"""
    store = ProjectStore(workspace)
    project = store.create_project("跨层验收")
    store.set_data(
        project.id,
        "world",
        {
            "worldview": [],
            "characters": [],
            "locations": [{"id": "loc", "name": "旧地", "description": "d", "tags": [], "image": ""}],
            "factions": [],
            "history": [],
            "other": [],
        },
    )
    store.set_data(
        project.id,
        "events",
        {
            "state_variables": [],
            "nodes": [{"id": "start", "title": "开始", "type": "mainline"}],
            "edges": [],
        },
    )
    store.set_scene(
        project.id,
        "start",
        {
            "event_id": "start",
            "beats": [
                {
                    "id": "b1",
                    "kind": "narration",
                    "speaker": "",
                    "content": "到了。",
                    "location": "loc",
                    "effects": [],
                }
            ],
            "edges": [],
        },
    )
    baseline = capture_fragment_map(store, project.id)
    store.delete_scene(project.id, "start")
    after_delete = capture_fragment_map(store, project.id)
    changed, _added, deleted = diff_fragment_maps(baseline, after_delete)
    _expect("scene:start" in deleted, "删除情节文件是一等变化")

    store.set_scene(
        project.id,
        "start",
        {
            "event_id": "start",
            "beats": [
                {
                    "id": "b1",
                    "kind": "narration",
                    "speaker": "",
                    "content": "到了。",
                    "location": "loc",
                    "effects": [],
                }
            ],
            "edges": [],
        },
    )
    baseline = capture_fragment_map(store, project.id)
    store.set_data(
        project.id,
        "world",
        {
            "worldview": [],
            "characters": [],
            "locations": [{"id": "other", "name": "别处", "description": "d", "tags": [], "image": ""}],
            "factions": [],
            "history": [],
            "other": [],
        },
    )
    current = capture_fragment_map(store, project.id)
    report = validate_fragment_maps(baseline, current)
    _expect(not report.ok, "只改世界设定造成情节地点引用失效时基础验收失败")
    _expect(
        any(issue.key.startswith("scene:") for issue in report.issues),
        "跨层引用错误挂到受影响的情节文件",
    )


class _BadWorldAgent:
    """写入非法 world.json，验证修复耗尽后正式项目回到基线。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id

    async def ainvoke(self, inputs, config=None):
        del config
        self.store.data_file(self.project_id, "world").write_text("{", encoding="utf-8")
        return {"messages": inputs["messages"] + [_Ai("写坏了")]}


class _Ai:
    """最小 AI 消息。"""

    def __init__(self, content: str):
        self.content = content
        self.type = "ai"


async def _repair_exhaust_check(workspace: Path) -> None:
    """修复耗尽不得留下非法文件，也不增加 revision。"""
    store = ProjectStore(workspace)
    project = store.create_project("修复耗尽")
    session = ProjectSession(
        store,
        project.id,
        agent=_BadWorldAgent(store, project.id),
        max_repair=0,
    )
    result = await session.asend("写世界")
    _expect(result.aborted and not result.committed, "修复耗尽返回事务失败")
    _expect(not store.data_file(project.id, "world").exists(), "非法 world 未留在正式项目")
    _expect(store.load_meta(project.id).revisions.get("world", 0) == 0, "失败回合不增加 revision")


def _workspace_isolation_check(workspace: Path) -> None:
    """草稿写入不得出现在正式 GET 使用的项目目录。"""
    store = ProjectStore(workspace)
    project = store.create_project("草稿隔离")
    service = TurnWorkspaceService(store)
    turn = service.begin(project.id, "turn-iso")
    turn.draft_store.set_text(project.id, "intent", "草稿意图")
    _expect(store.get_text(project.id, "intent") == "", "正式存储在提交前看不到草稿")
    _expect(".turn_workspaces" in str(turn.draft_dir), "草稿目录位于项目 /project 之外")
    service.abort(turn)


def _validation_promotion_check(workspace: Path) -> None:
    """草稿检测只在指纹匹配时晋升；改内容后旧报告不晋升；commit 失败恢复基线。"""
    empty_events = {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "end", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "end"}],
    }
    changed_events = {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "开始改写", "type": "mainline"},
            {"id": "end", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "end"}],
    }
    later_events = {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "最终标题", "type": "mainline"},
            {"id": "end", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "end"}],
    }
    store = ProjectStore(workspace)
    project = store.create_project("检测晋升")
    store.set_data(project.id, "events", empty_events)
    baseline_fp = store.validation_fingerprint(project.id)
    store.save_validation_record(
        project.id,
        fingerprint=baseline_fp,
        report={
            "status": "passed",
            "engine_version": ENGINE_VERSION,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "issues": [],
        },
    )
    service = TurnWorkspaceService(store)

    stale = service.begin(project.id, "stale-report")
    stale.draft_store.set_data(project.id, "events", changed_events)
    stale.draft_store.save_validation_record(
        project.id,
        fingerprint=baseline_fp,
        report={
            "status": "failed",
            "engine_version": ENGINE_VERSION,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "issues": [{"kind": "stale"}],
        },
    )
    stale_result = service.commit(stale)
    _expect(not stale_result.validation_promoted, "检测后再改内容时旧报告不晋升")
    _expect(
        store.validation_state(project.id)["status"] == "not_checked",
        "正式面板因指纹不一致显示 not_checked",
    )

    matched = service.begin(project.id, "matched-report")
    matched.draft_store.set_data(project.id, "events", later_events)
    matched_fp = matched.draft_store.validation_fingerprint(project.id)
    matched.draft_store.save_validation_record(
        project.id,
        fingerprint=matched_fp,
        report={
            "status": "failed",
            "engine_version": ENGINE_VERSION,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "issues": [{"kind": "ok"}],
        },
    )
    matched_result = service.commit(matched)
    _expect(matched_result.validation_promoted, "指纹匹配时 commit 晋升草稿报告")
    _expect(store.validation_state(project.id)["status"] == "failed", "晋升后正式状态来自草稿报告")

    failing = service.begin(project.id, "fail-commit")
    failing.draft_store.set_data(project.id, "events", changed_events)
    import narrative_forge.orchestrator.turn_workspace as tw

    original_bump = tw._bump_versions

    def boom(*args, **kwargs):
        raise RuntimeError("bump fail")

    tw._bump_versions = boom
    try:
        raised = False
        try:
            service.commit(failing)
        except RuntimeError:
            raised = True
        _expect(raised, "commit 失败抛出")
        _expect(
            store.get_data(project.id, "events") == later_events,
            "失败时正文回到提交前正式版本",
        )
        _expect(
            store.validation_state(project.id)["status"] == "failed",
            "commit 失败恢复 validation 基线（本回合开始时的正式报告）",
        )
    finally:
        tw._bump_versions = original_bump


def _sidecar_lease_check() -> None:
    """TurnControl 旁路线程执行同步 LEASE 工具时仍持有同一 coordinator，两次写入串行。"""
    coordinator = WriteLeaseCoordinator()
    controller = TurnStopController("lease-turn")
    token_lease = current_write_lease.set(coordinator)
    token_stop = current_turn_stop.set(controller)
    intervals: list[tuple[float, float]] = []
    seen: list[bool] = []
    mw = TurnControlMiddleware()
    request = SimpleNamespace(tool_call={"name": "task"}, tool=SimpleNamespace(name="task"))

    def handler(_request):
        seen.append(current_write_lease.get() is coordinator)
        with coordinator.hold_sync():
            started = time.time()
            time.sleep(0.05)
            ended = time.time()
            intervals.append((started, ended))
        return "ok"

    try:
        ctx1 = contextvars.copy_context()
        ctx2 = contextvars.copy_context()
        threads = [
            threading.Thread(
                target=lambda ctx=ctx1: ctx.run(mw.wrap_tool_call, request, handler),
                daemon=True,
            ),
            threading.Thread(
                target=lambda ctx=ctx2: ctx.run(mw.wrap_tool_call, request, handler),
                daemon=True,
            ),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        current_write_lease.reset(token_lease)
        current_turn_stop.reset(token_stop)
    _expect(len(seen) == 2 and all(seen), "旁路线程仍能读取同一写租约 coordinator")
    first, second = sorted(intervals)
    _expect(first[1] <= second[0] + 1e-4, "两个同步写调用实际串行")


class _WorkspaceIntentAgent:
    """经真实 ProjectSession 工作存储写意图，验证草稿隔离与提交。"""

    def __init__(self) -> None:
        self.session = None

    async def astream_events(self, inputs, version, config):
        del inputs, version, config
        store = self.session._work_store
        store.set_text(self.session.project_id, "intent", "生产链路意图")
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [SimpleNamespace(type="ai", content="完成")]}},
        }


async def _production_workspace_check(workspace: Path) -> None:
    """真实 ProjectSession + TurnWorkspace 覆盖草稿隔离、提交和 abort。"""
    store = ProjectStore(workspace)
    project = store.create_project("生产链路")
    store.set_text(project.id, "intent", "基线意图")
    service = TurnWorkspaceService(store)
    agent = _WorkspaceIntentAgent()
    session = ProjectSession(store, project.id, agent=agent, max_repair=0)
    agent.session = session
    turn = service.begin(project.id, "prod-turn")
    events = [event async for event in session.astream_turn(
        "写意图",
        turn_id="prod-turn",
        workspace=turn,
    )]
    completed = next((event for event in events if event.type == "completed"), None)
    _expect(completed is not None and completed.data.get("committed"), "生产链路提交成功")
    _expect(store.get_text(project.id, "intent") == "生产链路意图", "commit 后正式内容更新")

    abort_turn = service.begin(project.id, "abort-turn")
    abort_turn.draft_store.set_text(project.id, "intent", "应被丢弃")
    preview = service.publish_checkpoint(abort_turn, step_id="root")
    _expect(preview is not None, "abort 前可以发布检查点")
    _expect(store.get_text(project.id, "intent") == "生产链路意图", "检查点不改正式内容")
    service.abort(abort_turn)
    _expect(store.get_text(project.id, "intent") == "生产链路意图", "abort 后正式内容保持")
    _expect(service.get(project.id, "abort-turn") is None, "abort 后工作区被移除")


def main() -> int:
    """运行写租约、权限与内容验收检查。"""
    print("── Agent 事务化执行框架检查")
    asyncio.run(_lease_serial_check())
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        _permission_check(root / "perm")
        _content_diff_check(root / "diff")
        _delete_and_cross_layer_check(root / "xref")
        asyncio.run(_repair_exhaust_check(root / "repair"))
        _workspace_isolation_check(root / "ws")
        _validation_promotion_check(root / "validation")
        _sidecar_lease_check()
        asyncio.run(_production_workspace_check(root / "prod"))
    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
