"""离线单测：Agent 修改摘要、持久恢复、整轮撤销和冲突保护。

不调用 LLM。测试直接模拟 Agent 完成后的项目写入和 revision 登记，验证程序
差异覆盖稳定 id 对象与文本行，且撤销只在项目仍等于回合结束状态时执行。
"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Callable

from narrative_forge.core.agent_changeset_service import (
    AgentChangesetConflict,
    AgentChangesetService,
)
from narrative_forge.api.routes import _run_turn
from narrative_forge.api.runtime import EventBus, ProjectLocks
from narrative_forge.orchestrator import TurnEvent
from narrative_forge.orchestrator.turn_control import AgentTurnStopped
from narrative_forge.core.store import ProjectStore


def _expect(condition: bool, message: str) -> None:
    """断言条件成立并输出检查结果。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


def _expect_raises(
    error_type: type[Exception],
    action: Callable[[], object],
    message: str,
) -> None:
    """断言调用抛出指定异常。"""
    try:
        action()
    except error_type:
        print(f"   PASS  {message}")
        return
    except Exception as exc:
        print(f"   FAIL  {message} — 实际异常 {type(exc).__name__}: {exc}")
        raise SystemExit(1) from exc
    print(f"   FAIL  {message} — 未抛出异常")
    raise SystemExit(1)


def run_check(workspace: Path) -> None:
    """运行 changeset 差异、撤销、保留和冲突检查。"""
    store = ProjectStore(workspace)
    service = AgentChangesetService(store)
    project = store.create_project("Agent 修改集检查")
    store.set_text(project.id, "intent", "第一行\n第二行")
    store.bump_revision(project.id, "intent")
    store.set_data(
        project.id,
        "world",
        {
            "characters": [
                {
                    "id": "char-hero",
                    "name": "旧名字",
                    "description": "保持不变",
                    "tags": [],
                }
            ],
            "locations": [],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    store.bump_revision(project.id, "world")

    baseline = service.capture_baseline(project.id)
    store.set_text(project.id, "intent", "第一行\n修改后的第二行\n第三行")
    intent_output_revision = store.bump_revision(project.id, "intent")
    store.set_data(
        project.id,
        "world",
        {
            "characters": [
                {
                    "id": "char-hero",
                    "name": "新名字",
                    "description": "保持不变",
                    "tags": [],
                },
                {
                    "id": "char-guide",
                    "name": "向导",
                    "description": "新增角色",
                    "tags": [],
                },
            ],
            "locations": [],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    world_output_revision = store.bump_revision(project.id, "world")
    store.set_scene(
        project.id,
        "event-opening",
        {
            "event_id": "event-opening",
            "beats": [
                {
                    "id": "beat-start",
                    "type": "narration",
                    "text": "开场",
                    "location": "loc-start",
                    "speaker": None,
                    "effects": [],
                }
            ],
            "edges": [],
        },
    )
    scene_output_revision = store.bump_scene_revision(project.id, "event-opening")
    added_asset_name = store.add_asset(
        project.id,
        "generated.png",
        b"agent-generated-image",
    )

    changeset = service.complete(project.id, "turn-001", baseline)
    _expect(changeset is not None, "实际修改形成 changeset")
    assert changeset is not None
    _expect(changeset.status == "pending", "新 changeset 初始为待检查")
    _expect(changeset.counts["total"] >= 4, "摘要覆盖文本、字段和新增对象")
    paths = {
        detail.path
        for fragment in changeset.fragments
        for detail in fragment.details
    }
    _expect(
        "world.characters[char-hero].name" in paths,
        "世界卡片按稳定 id 生成字段级差异",
    )
    _expect(
        any("char-guide" in path for path in paths),
        "新增世界卡片保留稳定 id",
    )
    _expect(
        any(path.startswith("intent.lines") for path in paths),
        "自由文本生成行级差异块",
    )
    _expect(
        f"assets[{added_asset_name}]" in paths,
        "Agent 本轮新增配图进入确定性摘要",
    )
    scene_detail = next(
        detail
        for fragment in changeset.fragments
        for detail in fragment.details
        if detail.data_type == "scene"
    )
    _expect(
        scene_detail.location.event_id == "event-opening",
        "情节差异可定位到所属事件",
    )
    _expect(
        scene_detail.object_type == "scene"
        and scene_detail.location.object_type == "scene"
        and scene_detail.location.object_id == "event-opening",
        "整个新增情节保留 scene 类型，前端不得把事件 id 当作 beat id",
    )
    _expect(
        service.latest(project.id).id == changeset.id,
        "刷新后可从磁盘恢复最近 changeset",
    )
    reverted = service.revert(project.id, changeset.id)
    _expect(reverted.status == "reverted", "整轮撤销更新 changeset 状态")
    _expect(
        store.get_text(project.id, "intent") == "第一行\n第二行",
        "撤销恢复回合前文本",
    )
    _expect(
        store.get_data(project.id, "world")["characters"][0]["name"] == "旧名字",
        "撤销恢复回合前结构化字段",
    )
    _expect(
        store.get_scene(project.id, "event-opening") is None,
        "撤销删除回合中新建的情节图",
    )
    _expect(
        store.asset_path(project.id, added_asset_name) is None,
        "撤销清理本轮新增配图，不留下孤立资产",
    )
    meta = store.load_meta(project.id)
    _expect(
        meta.revisions["intent"] > intent_output_revision
        and meta.revisions["world"] > world_output_revision
        and meta.scene_revisions["event-opening"] > scene_output_revision,
        "撤销通过新 revision 恢复，不回退历史版本号",
    )
    _expect(
        service.revert(project.id, changeset.id).status == "reverted",
        "重复撤销保持幂等",
    )

    conflict_baseline = service.capture_baseline(project.id)
    store.set_text(project.id, "outline", "Agent 写入")
    store.bump_revision(project.id, "outline")
    conflict_changeset = service.complete(project.id, "turn-002", conflict_baseline)
    assert conflict_changeset is not None
    store.set_text(project.id, "outline", "用户后续修改")
    store.bump_revision(project.id, "outline")
    _expect_raises(
        AgentChangesetConflict,
        lambda: service.revert(project.id, conflict_changeset.id),
        "后续 revision 变化时拒绝静默覆盖",
    )
    _expect(
        store.get_text(project.id, "outline") == "用户后续修改",
        "撤销冲突不改变后续人工内容",
    )
    kept = service.resolve_pending_implicitly(project.id)
    _expect(
        kept is not None
        and kept.status == "kept"
        and kept.resolution == "implicit_keep",
        "继续工作可把待检查修改登记为隐式保留",
    )
    _run_restore_baseline_check(workspace / "restore_baseline")
    _run_empty_container_expansion_check(workspace / "empty_world_events")


def _run_empty_container_expansion_check(workspace: Path) -> None:
    """空白项目第一次写出设定和事件图时，应按对象拆开，而不是整包一条。"""
    store = ProjectStore(workspace)
    service = AgentChangesetService(store)
    project = store.create_project("空文件拆成对象")
    baseline = service.capture_baseline(project.id)
    store.set_data(
        project.id,
        "world",
        {
            "characters": [
                {
                    "id": "char-guide",
                    "name": "向导",
                    "description": "熟悉旧城道路。",
                    "tags": [],
                },
                {
                    "id": "char-hero",
                    "name": "行者",
                    "description": "刚到码头。",
                    "tags": [],
                },
            ],
            "locations": [
                {
                    "id": "loc-dock",
                    "name": "下层码头",
                    "description": "潮水拍打船帮。",
                    "tags": [],
                }
            ],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    store.bump_revision(project.id, "world")
    store.set_data(
        project.id,
        "events",
        {
            "state_variables": [
                {
                    "id": "trust",
                    "name": "信任",
                    "type": "flag",
                    "initial": False,
                    "description": "",
                    "allowed": [],
                }
            ],
            "nodes": [
                {
                    "id": "ev-open",
                    "title": "抵达码头",
                    "summary": "船靠岸。",
                    "type": "mainline",
                    "characters": ["char-hero"],
                    "locations": ["loc-dock"],
                },
                {
                    "id": "ev-end",
                    "title": "离开",
                    "summary": "潮水退去。",
                    "type": "ending",
                    "characters": [],
                    "locations": [],
                },
            ],
            "edges": [
                {
                    "id": "edge-open-end",
                    "source": "ev-open",
                    "target": "ev-end",
                    "label": "继续前行",
                }
            ],
        },
    )
    store.bump_revision(project.id, "events")
    store.set_scene(
        project.id,
        "ev-open",
        {
            "event_id": "ev-open",
            "beats": [
                {
                    "id": "beat-open",
                    "kind": "narration",
                    "content": "船靠上码头。",
                    "effects": [],
                }
            ],
            "edges": [],
        },
    )
    store.bump_scene_revision(project.id, "ev-open")

    changeset = service.complete(project.id, "turn-empty-expand", baseline)
    _expect(changeset is not None, "空白项目首次写入形成 changeset")
    assert changeset is not None
    details = [detail for fragment in changeset.fragments for detail in fragment.details]
    world_details = [detail for detail in details if detail.data_type == "world"]
    event_details = [detail for detail in details if detail.data_type == "events"]
    scene_details = [detail for detail in details if detail.data_type == "scene"]
    world_types = {detail.object_type for detail in world_details}
    world_ids = {detail.object_id for detail in world_details}
    event_types = {detail.object_type for detail in event_details}
    _expect(
        world_types == {"character", "location"}
        and world_ids == {"char-guide", "char-hero", "loc-dock"}
        and all(detail.operation == "add" and detail.field is None for detail in world_details),
        "空设定文件按卡片拆成新增，不出现整包世界设定",
    )
    _expect(
        event_types == {"state_variable", "event", "event_edge"}
        and {detail.object_id for detail in event_details}
        == {"trust", "ev-open", "ev-end", "edge-open-end"}
        and all(detail.field is None for detail in event_details),
        "空事件图按变量、事件和选择拆开",
    )
    _expect(
        len(scene_details) == 1
        and scene_details[0].object_type == "scene"
        and scene_details[0].object_id == "ev-open",
        "整段情节仍保持一条，不拆成情节节点",
    )


def _run_restore_baseline_check(workspace: Path) -> None:
    """验证失败回滚恢复文本、结构、情节、配图、revision 和检测记录。"""
    store = ProjectStore(workspace)
    service = AgentChangesetService(store)
    project = store.create_project("失败回滚基线")
    store.set_text(project.id, "intent", "原始意图")
    store.bump_revision(project.id, "intent")
    store.set_data(
        project.id,
        "world",
        {
            "characters": [],
            "locations": [
                {
                    "id": "loc-dock",
                    "name": "下层码头",
                    "description": "旧地点",
                    "tags": [],
                }
            ],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    store.bump_revision(project.id, "world")
    store.set_scene(
        project.id,
        "ev-arrival",
        {
            "event_id": "ev-arrival",
            "beats": [],
            "edges": [],
        },
    )
    store.bump_scene_revision(project.id, "ev-arrival")
    original_asset = store.add_asset(project.id, "keep.png", b"keep-bytes")
    store.replace_validation_record_text(
        project.id,
        '{"status":"passed","fingerprint":{"digest":"abc"}}',
    )
    before_meta = store.load_meta(project.id)
    baseline = service.capture_baseline(project.id)

    store.set_text(project.id, "intent", "失败回合意图")
    store.set_data(
        project.id,
        "world",
        {
            "characters": [],
            "locations": [
                {
                    "id": "loc-bridge",
                    "name": "空中栈桥",
                    "description": "新地点",
                    "tags": [],
                }
            ],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    store.delete_scene(project.id, "ev-arrival")
    store.set_scene(
        project.id,
        "ev-new",
        {"event_id": "ev-new", "beats": [], "edges": []},
    )
    added_asset = store.add_asset(project.id, "tmp.png", b"tmp-bytes")
    store.write_asset_bytes(project.id, original_asset, b"overwritten")
    store.replace_validation_record_text(project.id, '{"status":"failed"}')
    store.bump_revision(project.id, "intent")
    store.bump_revision(project.id, "world")

    result = service.restore_to_baseline(project.id, baseline)
    _expect(result["changed"] is True, "失败回滚报告发生了恢复")
    _expect(
        store.get_text(project.id, "intent") == "原始意图",
        "失败回滚恢复文本片段",
    )
    world = store.get_data(project.id, "world")
    _expect(
        world is not None and world["locations"][0]["id"] == "loc-dock",
        "失败回滚恢复结构化设定",
    )
    _expect(
        store.get_scene(project.id, "ev-arrival") is not None
        and store.get_scene(project.id, "ev-new") is None,
        "失败回滚恢复原情节并删除本轮新增情节",
    )
    _expect(
        store.asset_path(project.id, added_asset) is None,
        "失败回滚删除本轮新增配图",
    )
    kept_asset = store.asset_path(project.id, original_asset)
    _expect(
        kept_asset is not None and kept_asset.read_bytes() == b"keep-bytes",
        "失败回滚恢复被覆盖的原配图字节",
    )
    after_meta = store.load_meta(project.id)
    _expect(
        after_meta.revisions == before_meta.revisions
        and after_meta.scene_revisions == before_meta.scene_revisions,
        "失败回滚把 revision 写回回合前，而不是再递增",
    )
    _expect(
        store.get_validation_record(project.id) == {
            "status": "passed",
            "fingerprint": {"digest": "abc"},
        },
        "失败回滚恢复正式检测记录",
    )
    _expect(service.latest(project.id) is None, "失败回滚不生成 changeset")


class _FailingWriteSession:
    """模拟 Agent 已写入项目但随后抛出递归超限。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id

    async def astream_turn(self, message: str, **_kwargs):
        """先写盘，再以与真实 GraphRecursionError 相近的方式失败。"""
        del message
        self.store.set_text(self.project_id, "intent", "本轮不应保留")
        yield TurnEvent("status", {"text": "正在修改"})
        raise RuntimeError(
            "Recursion limit of 50 reached without hitting a stop condition"
        )


class _WritingStubSession:
    """模拟一个真实写入 intent 并正常完成的 Agent 会话。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id

    async def astream_turn(self, message: str, **_kwargs):
        """写入项目并返回与正式会话一致的完成事件。"""
        del message
        self.store.set_text(self.project_id, "intent", "由 Agent 写入")
        revision = self.store.bump_revision(self.project_id, "intent")
        yield TurnEvent(
            "completed",
            {
                "text": "已完成修改",
                "updated": [["intent", revision]],
                "failed": {},
                "repairs": 0,
            },
        )


async def _run_turn_integration_check(workspace: Path) -> None:
    """验证正式回合编排会把 changeset 同时写入历史和 SSE 完成事件。"""
    store = ProjectStore(workspace)
    changesets = AgentChangesetService(store)
    project = store.create_project("Agent 回合接线检查")
    bus = EventBus()
    locks = ProjectLocks()
    queue = bus.subscribe(project.id)
    baseline = changesets.capture_baseline(project.id)
    await locks.acquire(project.id)
    await _run_turn(
        store,
        bus,
        locks,
        _WritingStubSession(store, project.id),
        project.id,
        "请修改意图",
        turn_id="turn-integration",
        changesets=changesets,
        changeset_baseline=baseline,
    )
    history = store.get_chat(project.id)
    embedded = history[-1].get("changeset") if history else None
    _expect(
        embedded
        and embedded.get("turn_id") == "turn-integration"
        and embedded.get("status") == "pending",
        "完整 Agent 回合把 changeset 持久化到助手消息",
    )
    completed_changeset = None
    while not queue.empty():
        event = queue.get_nowait()
        if event.get("type") == "turn_completed":
            completed_changeset = event.get("changeset")
    _expect(
        completed_changeset
        and completed_changeset.get("id") == embedded.get("id"),
        "turn_completed 实时事件携带同一 changeset",
    )


async def _run_turn_failure_rollback_check(workspace: Path) -> None:
    """验证编排层在回合异常时丢弃全部写入，且不生成 changeset。"""
    store = ProjectStore(workspace)
    changesets = AgentChangesetService(store)
    project = store.create_project("失败回合回滚接线")
    store.set_text(project.id, "intent", "回合前意图")
    original_revision = store.bump_revision(project.id, "intent")
    bus = EventBus()
    locks = ProjectLocks()
    queue = bus.subscribe(project.id)
    baseline = changesets.capture_baseline(project.id)
    await locks.acquire(project.id)
    await _run_turn(
        store,
        bus,
        locks,
        _FailingWriteSession(store, project.id),
        project.id,
        "请修改意图",
        turn_id="turn-rollback",
        changesets=changesets,
        changeset_baseline=baseline,
    )
    _expect(
        store.get_text(project.id, "intent") == "回合前意图",
        "失败回合丢弃 Agent 已写入的内容",
    )
    _expect(
        store.load_meta(project.id).revisions["intent"] == original_revision,
        "失败回合不留下递增后的 revision",
    )
    _expect(changesets.latest(project.id) is None, "失败回合不形成 changeset")
    history = store.get_chat(project.id)
    _expect(
        history
        and history[-1].get("role") == "system"
        and "未保留任何修改" in str(history[-1].get("text")),
        "失败提示明确说明未保留修改",
    )
    error_event = None
    while not queue.empty():
        event = queue.get_nowait()
        if event.get("type") == "error":
            error_event = event
    _expect(
        error_event is not None
        and "未保留任何修改" in str(error_event.get("message")),
        "SSE 错误事件同步说明未保留修改",
    )
    _expect(not locks.is_busy(project.id), "失败回滚后释放项目锁")


class _UserStopSession:
    """模拟已写入项目后由用户停止。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id
        self.messages = ["prior"]

    async def astream_turn(self, message: str, **_kwargs):
        """写入后再抛出用户停止，且截断内部消息由编排层负责。"""
        del message
        self.store.set_text(self.project_id, "intent", "停止后不应保留")
        yield TurnEvent(
            "tool_start",
            {
                "tool": "write_file",
                "label": "正在撰写内容",
                "step_id": "write-1",
            },
        )
        raise AgentTurnStopped()


async def _run_turn_user_stop_check(workspace: Path) -> None:
    """用户停止后整轮恢复基线，不生成 changeset，历史保留用户消息。"""
    store = ProjectStore(workspace)
    changesets = AgentChangesetService(store)
    project = store.create_project("用户停止回滚接线")
    store.set_text(project.id, "intent", "回合前意图")
    original_revision = store.bump_revision(project.id, "intent")
    bus = EventBus()
    locks = ProjectLocks()
    queue = bus.subscribe(project.id)
    baseline = changesets.capture_baseline(project.id)
    await locks.acquire(project.id)
    await _run_turn(
        store,
        bus,
        locks,
        _UserStopSession(store, project.id),
        project.id,
        "请修改意图",
        turn_id="turn-user-stop",
        changesets=changesets,
        changeset_baseline=baseline,
    )
    _expect(
        store.get_text(project.id, "intent") == "回合前意图",
        "用户停止丢弃 Agent 已写入的内容",
    )
    _expect(
        store.load_meta(project.id).revisions["intent"] == original_revision,
        "用户停止不递增 revision",
    )
    _expect(changesets.latest(project.id) is None, "用户停止不生成 changeset")
    history = store.get_chat(project.id)
    _expect(history[0]["role"] == "user" and history[0]["text"] == "请修改意图", "保留本轮用户消息")
    assistant = history[-1]
    _expect(
        assistant.get("stopped") is True
        and assistant.get("rolled_back") is True
        and assistant.get("changeset") is None
        and "均未保留" in assistant.get("text", ""),
        "停止后的助手记录固定文案且无 changeset",
    )
    _expect(
        assistant.get("steps")
        and assistant["steps"][0].get("outcome") == "rolled_back",
        "已启动步骤标记为结果已撤销",
    )
    types = []
    while not queue.empty():
        types.append(queue.get_nowait().get("type"))
    _expect("turn_stopped" in types and "turn_completed" not in types, "停止路径不发送 turn_completed")
    _expect("error" not in types, "用户停止不走技术失败 error 事件")
    _expect(not locks.is_busy(project.id), "用户停止后释放项目锁")


class _PartialBudgetSession:
    """合法写入意图、非法写入世界，并报告预算主动收口。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id
        self.last_result = None

    async def astream_turn(self, message: str, **_kwargs):
        """写入一个合法片段和一个非法片段后正常结束。"""
        del message
        self.store.set_text(self.project_id, "intent", "预算收口后的意图")
        revision = self.store.bump_revision(self.project_id, "intent")
        self.store.data_file(self.project_id, "world").write_text("{", encoding="utf-8")
        completed = {
            "text": "先写到这里",
            "updated": [["intent", revision]],
            "failed": {"world": "不是合法 JSON"},
            "repairs": 0,
            "partial": True,
            "budget_closed": True,
            "completed_parts": ["创作意图"],
            "remaining_parts": ["世界设定"],
        }
        self.last_result = type("Turn", (), completed)()
        yield TurnEvent("completed", completed)


async def _run_turn_partial_budget_check(workspace: Path) -> None:
    """预算收口后只登记合法片段，非法片段恢复基线，changeset 不含坏数据。"""
    store = ProjectStore(workspace)
    changesets = AgentChangesetService(store)
    project = store.create_project("预算部分完成")
    store.set_text(project.id, "intent", "收口前意图")
    store.bump_revision(project.id, "intent")
    store.set_data(
        project.id,
        "world",
        {
            "characters": [],
            "locations": [],
            "factions": [],
            "history": [],
            "worldview": [],
            "other": [],
        },
    )
    world_revision = store.bump_revision(project.id, "world")
    bus = EventBus()
    locks = ProjectLocks()
    queue = bus.subscribe(project.id)
    baseline = changesets.capture_baseline(project.id)
    await locks.acquire(project.id)
    await _run_turn(
        store,
        bus,
        locks,
        _PartialBudgetSession(store, project.id),
        project.id,
        "请继续创作",
        turn_id="turn-partial",
        changesets=changesets,
        changeset_baseline=baseline,
    )
    _expect(
        store.get_text(project.id, "intent") == "预算收口后的意图",
        "预算收口保留合法意图",
    )
    world = store.get_data(project.id, "world")
    _expect(
        isinstance(world, dict) and world.get("characters") == [],
        "非法世界设定恢复到本轮基线",
    )
    _expect(
        store.load_meta(project.id).revisions.get("world") == world_revision,
        "恢复非法片段时不留下错误 revision",
    )
    history = store.get_chat(project.id)
    assistant = history[-1] if history else {}
    changeset = assistant.get("changeset") or {}
    _expect(bool(assistant.get("partial") and assistant.get("budget_closed")), "历史记录部分完成")
    _expect(
        [fragment.get("data_type") for fragment in changeset.get("fragments") or []] == ["intent"],
        "部分 changeset 只包含合法片段",
    )
    completed = None
    while not queue.empty():
        event = queue.get_nowait()
        if event.get("type") == "turn_completed":
            completed = event
    _expect(
        completed
        and completed.get("budget_closed") is True
        and completed.get("remaining_parts") == ["世界设定"],
        "turn_completed 带未完成范围",
    )


def main() -> int:
    """在临时工作区执行检查并清理全部产物。"""
    workspace = Path(tempfile.mkdtemp(prefix="nf_agent_changeset_"))
    print("── Agent 修改摘要与整轮撤销检查")
    try:
        run_check(workspace)
        asyncio.run(_run_turn_integration_check(workspace / "turn_integration"))
        asyncio.run(_run_turn_failure_rollback_check(workspace / "turn_rollback"))
        asyncio.run(_run_turn_user_stop_check(workspace / "turn_stop"))
        asyncio.run(_run_turn_partial_budget_check(workspace / "turn_partial"))
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
