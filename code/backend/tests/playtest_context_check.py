"""离线检查：试玩情景重放、失败降级，以及不写入聊天、不残留到下一轮。"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

from narrative_forge.agents.prompts import MAIN_AGENT_PROMPT
from narrative_forge.core.models.event_graph import EventGraph
from narrative_forge.core.models.scene_graph import SceneGraph
from narrative_forge.core.playtest_context import (
    PLAYTEST_NOTE_PREFIX,
    REASON_INVALID,
    REASON_MISMATCH,
    REASON_STALE,
    PlaytestContextInput,
    PlaytestTakenEdge,
    format_playtest_note,
    replay_playtest_route,
    resolve_playtest_context,
)
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.session import ProjectSession


def _expect(condition: bool, message: str) -> None:
    """断言条件成立；失败则退出。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


def _events() -> dict:
    """含分叉与 scalar 截断的小事件图。"""
    return {
        "state_variables": [
            {
                "id": "trust",
                "name": "信任度",
                "type": "scalar",
                "allowed": [],
                "min": 0,
                "max": 100,
                "initial": 10,
                "description": "",
                "value_descriptions": {},
            },
            {
                "id": "helped",
                "name": "帮过守卫",
                "type": "flag",
                "allowed": [],
                "min": None,
                "max": None,
                "initial": False,
                "description": "",
                "value_descriptions": {},
            },
        ],
        "nodes": [
            {"id": "ev-gate", "title": "城门", "summary": "", "type": "mainline", "characters": [], "locations": []},
            {"id": "ev-end", "title": "进城", "summary": "", "type": "ending", "characters": [], "locations": []},
        ],
        "edges": [
            {
                "id": "ee-enter",
                "source": "ev-gate",
                "target": "ev-end",
                "label": "进城",
                "condition": {"var": "trust", "op": ">=", "value": 20},
            }
        ],
    }


def _scene_gate() -> dict:
    """城门情节：帮助守卫会加信任度并截断到 100。"""
    return {
        "event_id": "ev-gate",
        "beats": [
            {
                "id": "b-ask",
                "kind": "dialogue",
                "speaker": "char-guard",
                "content": "我从没见过你。",
                "location": "loc-gate",
                "effects": [],
            },
            {
                "id": "b-help",
                "kind": "narration",
                "speaker": "",
                "content": "你帮守卫搬开路障。",
                "location": "loc-gate",
                "effects": [
                    {"var": "helped", "op": "set", "value": True},
                    {"var": "trust", "op": "add", "value": 95},
                ],
            },
            {
                "id": "b-leave",
                "kind": "narration",
                "speaker": "",
                "content": "你转身离开。",
                "location": "loc-gate",
                "effects": [],
            },
        ],
        "edges": [
            {
                "id": "se-help",
                "source": "b-ask",
                "target": "b-help",
                "label": "帮助守卫",
                "condition": None,
            },
            {
                "id": "se-leave",
                "source": "b-ask",
                "target": "b-leave",
                "label": "转身离开",
                "condition": None,
            },
        ],
    }


def _scene_end() -> dict:
    """结局事件的单节点情节。"""
    return {
        "event_id": "ev-end",
        "beats": [
            {
                "id": "b-end",
                "kind": "narration",
                "speaker": "",
                "content": "你走进城里。",
                "location": "loc-gate",
                "effects": [],
            }
        ],
        "edges": [],
    }


def _seed_project(store: ProjectStore) -> str:
    """写入可重放的小项目并登记 revision。"""
    project = store.create_project("试玩情景")
    store.set_data(project.id, "events", _events())
    store.bump_revision(project.id, "events")
    store.set_data(
        project.id,
        "world",
        {
            "worldview": [],
            "characters": [{"id": "char-guard", "name": "守卫", "description": "", "tags": [], "image": ""}],
            "locations": [{"id": "loc-gate", "name": "城门", "description": "", "tags": [], "image": ""}],
            "factions": [],
            "history": [],
            "other": [],
        },
    )
    store.bump_revision(project.id, "world")
    store.set_scene(project.id, "ev-gate", _scene_gate())
    store.bump_scene_revision(project.id, "ev-gate")
    store.set_scene(project.id, "ev-end", _scene_end())
    store.bump_scene_revision(project.id, "ev-end")
    return project.id


def _context(store: ProjectStore, project_id: str, **overrides) -> PlaytestContextInput:
    """按当前 meta 构造一份默认情景。"""
    meta = store.load_meta(project_id)
    base = PlaytestContextInput(
        status="playing",
        phase="event_boundary",
        revisions=dict(meta.revisions),
        scene_revisions=dict(meta.scene_revisions),
        event_id="ev-gate",
        beat_id="b-help",
        vars={"trust": 100, "helped": True},
        taken_edges=[PlaytestTakenEdge(kind="scene", edge_id="se-help")],
        focus_edge_id="ee-enter",
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def _replay_forks() -> None:
    """重放帮助守卫的路线，应看到未选的离开选项，并把 trust 截断到 100。"""
    scenes = {"ev-gate": SceneGraph.model_validate(_scene_gate()), "ev-end": SceneGraph.model_validate(_scene_end())}
    resolved = replay_playtest_route(
        EventGraph.model_validate(_events()),
        scenes.get,
        [PlaytestTakenEdge(kind="scene", edge_id="se-help")],
        phase="event_boundary",
    )
    _expect(resolved.ok, "合法实际边路线可以重放")
    _expect(resolved.vars["trust"] == 100, "add +95 后按 scalar 上限截断为 100")
    _expect(resolved.vars["helped"] is True, "帮助守卫写入 flag")
    _expect(resolved.beat_id == "b-help", "停在帮助后的节点")
    _expect(resolved.at_event_boundary, "终止情节节点标为待进事件层")
    fork = resolved.forks[0]
    labels = {item.edge_id: item for item in fork.alternatives}
    _expect(labels["se-help"].chosen, "记录实际选择")
    _expect(not labels["se-leave"].chosen and labels["se-leave"].enabled, "同节点未选但当时可用")
    _expect(any(choice.edge_id == "ee-enter" for choice in resolved.current_choices), "随后列出事件层进城选项")


def _invalid_and_stale(store: ProjectStore, project_id: str) -> None:
    """非法边、版本过期和变量不一致都只降级，不抛错。"""
    scenes = {"ev-gate": SceneGraph.model_validate(_scene_gate())}
    bad_route = replay_playtest_route(
        EventGraph.model_validate(_events()),
        scenes.get,
        [PlaytestTakenEdge(kind="scene", edge_id="missing")],
        phase="scene",
    )
    _expect(not bad_route.ok and bad_route.reason == REASON_INVALID, "不存在的边不能重放")

    stale = resolve_playtest_context(
        store,
        project_id,
        _context(store, project_id, revisions={"events": 99}),
    )
    _expect(not stale.ok and stale.reason == REASON_STALE, "开局版本不同则情景不可用")

    mismatch = resolve_playtest_context(
        store,
        project_id,
        _context(store, project_id, vars={"trust": 10, "helped": True}),
    )
    _expect(not mismatch.ok and mismatch.reason == REASON_MISMATCH, "变量与重放结果不一致")

    ok = resolve_playtest_context(store, project_id, _context(store, project_id))
    _expect(ok.ok, "版本与路线匹配时情景可用")
    note = format_playtest_note(ok)
    _expect(note.startswith(PLAYTEST_NOTE_PREFIX), "可用情景编成系统试玩说明")
    _expect("se-leave" in note and "未走" in note, "说明包含当时未选的分叉")
    _expect("我从没见过你" in note or "你帮守卫搬开路障" in note, "说明带当前正文")
    unavailable = format_playtest_note(stale)
    _expect("不可用" in unavailable, "失败说明要求用户重开或点名对象")


class _EchoAgent:
    """记录本轮消息，不写项目。"""

    def __init__(self) -> None:
        self.seen: list[list] = []

    async def astream_events(self, inputs, version, config):
        del version, config
        messages = list(inputs.get("messages") or [])
        self.seen.append(messages)
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": messages + [SimpleNamespace(type="ai", content="好")] }},
        }


def _message_text(message: object) -> str:
    if isinstance(message, dict):
        return str(message.get("content") or "")
    return str(getattr(message, "content", "") or "")


async def _session_isolation(workspace: Path) -> None:
    """试玩说明进入本轮，不写 chat.jsonl，也不留到下一轮。"""
    store = ProjectStore(workspace)
    project_id = _seed_project(store)
    agent = _EchoAgent()
    session = ProjectSession(store, project_id, agent=agent, max_repair=0)
    note = format_playtest_note(resolve_playtest_context(store, project_id, _context(store, project_id)))
    events = [event async for event in session.astream_turn("这句对白有点怪", playtest_note=note)]
    fed = "\n".join(_message_text(item) for batch in agent.seen for item in batch)
    _expect(PLAYTEST_NOTE_PREFIX in fed, "本轮 Agent 读到试玩说明")
    _expect(
        not any(PLAYTEST_NOTE_PREFIX in _message_text(item) for item in session.messages),
        "收口后内存消息链不再保留试玩说明",
    )
    _expect(
        not any(
            event.type == "status" and PLAYTEST_NOTE_PREFIX in str(event.data.get("text", ""))
            for event in events
        ),
        "试玩说明不作为 SSE status 发出",
    )
    store.append_chat(project_id, {"role": "user", "text": "这句对白有点怪"})
    history = store.get_chat(project_id)
    _expect(all(PLAYTEST_NOTE_PREFIX not in str(item.get("text", "")) for item in history), "chat.jsonl 只有用户原文")

    async for _event in session.astream_turn("再改一下"):
        pass
    second = "\n".join(_message_text(item) for item in agent.seen[-1])
    _expect(PLAYTEST_NOTE_PREFIX not in second, "下一轮不再带上一轮试玩位置")


def main() -> int:
    """运行全部离线断言。"""
    print("── 试玩情景重放")
    _replay_forks()
    workspace = Path(tempfile.mkdtemp(prefix="playtest-context-"))
    try:
        store = ProjectStore(workspace)
        project_id = _seed_project(store)
        _invalid_and_stale(store, project_id)
        print("── 回合隔离")
        asyncio.run(_session_isolation(workspace / "session"))
        _expect("[系统试玩]" in MAIN_AGENT_PROMPT, "主 Agent prompt 说明试玩情景")
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    print("playtest_context_check: pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
