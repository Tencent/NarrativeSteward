"""离线检查：原子文件后端与单一 Scene Agent 多文件契约（不调用真实 LLM）。"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from narrative_forge.agents.backends import AtomicFilesystemBackend
from narrative_forge.agents.scene_batch_tool import build_scene_batch_tool
from narrative_forge.agents.subagents import build_subagents
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.session import ProjectSession, TurnEvent
from narrative_forge.orchestrator.trace_context import emit_nested_event


def _events() -> dict:
    """构造两个事件的最小合法事件图。"""
    return {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "mid", "title": "中段", "type": "optional"},
            {"id": "ending", "title": "结局", "type": "ending"},
        ],
        "edges": [
            {"id": "to-ending", "source": "start", "target": "ending", "label": ""}
        ],
    }


def _scene(event_id: str) -> dict:
    """构造单 beat 合法情节。"""
    beat_id = f"{event_id}-beat"
    return {
        "event_id": event_id,
        "beats": [
            {
                "id": beat_id,
                "kind": "narration",
                "speaker": "",
                "content": "推进。",
                "location": "loc",
                "effects": [],
            }
        ],
        "edges": [],
    }


class _MultiSceneAgent:
    """一次 task 内写入三份情节，模拟单个 Scene Agent 多文件职责。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id

    async def astream_events(self, inputs, version, config):
        del inputs, version, config
        yield {
            "event": "on_tool_start",
            "name": "task",
            "run_id": "scene-task",
            "parent_ids": [],
            "data": {"input": {"subagent_type": "scene-builder"}},
        }
        for event_id in ("start", "mid", "ending"):
            self.store.set_scene(self.project_id, event_id, _scene(event_id))
            emit_nested_event(
                TurnEvent(
                    "tool_start",
                    {
                        "tool": "write_file",
                        "agent": "scene-builder",
                        "step_id": f"write-{event_id}",
                        "parent_step_id": "scene-task",
                        "label": "正在撰写内容",
                    },
                )
            )
            emit_nested_event(
                TurnEvent(
                    "tool_end",
                    {
                        "tool": "write_file",
                        "agent": "scene-builder",
                        "step_id": f"write-{event_id}",
                        "output": "ok",
                        "error": None,
                    },
                )
            )
        yield {
            "event": "on_tool_end",
            "name": "task",
            "run_id": "scene-task",
            "parent_ids": [],
            "data": {"output": "已写三张情节"},
        }
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [_Ai("完成")]}},
        }


class _Ai:
    """最小 AI 消息。"""

    def __init__(self, content: str):
        self.content = content
        self.type = "ai"


async def _multi_scene_check(store: ProjectStore, project_id: str) -> None:
    """一个 Scene Agent 一次 task 写入多份 scene，不创建每事件 worker。"""
    session = ProjectSession(
        store,
        project_id,
        agent=_MultiSceneAgent(store, project_id),
        max_repair=0,
    )
    events = [event async for event in session.astream_turn("生成情节")]
    writes = [
        event
        for event in events
        if event.type == "tool_start" and event.data.get("tool") == "write_file"
    ]
    assert len(writes) == 3
    assert all(item.data.get("parent_step_id") == "scene-task" for item in writes)
    assert store.get_scene(project_id, "start")["event_id"] == "start"
    assert store.get_scene(project_id, "mid")["event_id"] == "mid"
    assert store.get_scene(project_id, "ending")["event_id"] == "ending"


def run_check() -> None:
    """运行原子写与单 Scene Agent 多文件断言。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        backend = AtomicFilesystemBackend(root_dir=root, virtual_mode=True)
        assert backend.write("/intent.md", "旧内容").error is None
        assert backend.edit("/intent.md", "旧内容", "新内容").error is None
        assert (root / "intent.md").read_text("utf-8") == "新内容"
        assert not list(root.glob(".*.tmp"))
        print("   PASS  Agent 文件创建与编辑均为单文件原子替换")

        names = [item["name"] for item in build_subagents(use_skills=False)]
        assert names.count("scene-builder") == 1
        print("   PASS  只有一个 scene-builder 专业身份")

        store = ProjectStore(root / "workspace")
        meta = store.create_project("多情节单 Agent")
        store.set_data(meta.id, "world", {
            "worldview": [],
            "characters": [],
            "locations": [
                {"id": "loc", "name": "地点", "description": "", "tags": [], "image": ""}
            ],
            "factions": [],
            "history": [],
            "other": [],
        })
        store.set_data(meta.id, "events", _events())
        asyncio.run(_multi_scene_check(store, meta.id))
        print("   PASS  一个 Scene Agent 一次任务写入多份情节")

        tool = build_scene_batch_tool(store, meta.id, model=object())
        result = asyncio.run(tool.ainvoke({"event_ids": ["start"], "request": "x"}))
        assert "已停用" in str(result)
        print("   PASS  旧批次工具已收缩为无并发兼容入口")


if __name__ == "__main__":
    run_check()
    print("\nOK · scene agent multi-file checks passed")
