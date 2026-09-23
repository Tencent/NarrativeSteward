"""离线检查：主/子 Agent 执行轨迹、信封字段、写入后预览不登记版本。"""

from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

from narrative_forge.agents.execution_middleware import (
    _format_checkpoint_feedback,
    checkpoint_invalid_user_status,
)
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.session import ProjectSession, TurnEvent
from narrative_forge.orchestrator.trace_context import emit_nested_event
from narrative_forge.orchestrator.trace_utils import (
    path_to_preview_target,
    serialize_trace_payload,
)


def _expect(condition: bool, message: str) -> None:
    """断言条件成立；失败则退出。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


class _MainMultiToolAgent:
    """主 Agent 连续两次工具调用，用于确认都挂在根步骤下。"""

    def __init__(self):
        self.seen_messages: list = []

    async def astream_events(self, inputs, version, config):
        del version, config
        self.seen_messages.append(list(inputs.get("messages") or []))
        for run_id in ("read-a", "write-b"):
            yield {
                "event": "on_tool_start",
                "name": "read_file" if run_id == "read-a" else "write_file",
                "run_id": run_id,
                "parent_ids": [],
                "metadata": {"lc_agent_name": "main-agent"},
                "data": {"input": {"path": "/project/intent.md"}},
            }
            yield {
                "event": "on_chat_model_stream",
                "metadata": {"lc_agent_name": "main-agent"},
                "data": {"chunk": SimpleNamespace(content="过程文本")},
            }
            yield {
                "event": "on_tool_end",
                "name": "read_file" if run_id == "read-a" else "write_file",
                "run_id": run_id,
                "parent_ids": [],
                "metadata": {"lc_agent_name": "main-agent"},
                "data": {"output": "ok"},
            }
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [SimpleNamespace(type="ai", content="完成")]}},
        }


class _NestedWorkerAgent:
    """在批量工具内部回灌子事件，确认不会成为轨迹黑洞。"""

    async def astream_events(self, inputs, version, config):
        del inputs, version, config
        yield {
            "event": "on_tool_start",
            "name": "task",
            "run_id": "batch",
            "parent_ids": [],
            "data": {"input": {"subagent_type": "scene-builder", "event_ids": ["ev-1"]}},
        }
        emit_nested_event(
            TurnEvent(
                "agent_text",
                {
                    "text": "正在写情节",
                    "agent": "scene-batch-worker",
                    "step_id": "batch",
                    "parent_step_id": "batch",
                },
            )
        )
        emit_nested_event(
            TurnEvent(
                "tool_start",
                {
                    "tool": "write_file",
                    "agent": "scene-batch-worker",
                    "step_id": "worker-write",
                    "parent_step_id": "batch",
                    "label": "正在撰写内容",
                    "input": {"path": "/project/scenes/ev-1.json"},
                },
            )
        )
        emit_nested_event(
            TurnEvent(
                "tool_end",
                {
                    "tool": "write_file",
                    "agent": "scene-batch-worker",
                    "step_id": "worker-write",
                    "output": "ok",
                    "error": None,
                    "duration_ms": 12,
                },
            )
        )
        yield {
            "event": "on_tool_end",
            "name": "task",
            "run_id": "batch",
            "parent_ids": [],
            "data": {"output": {"status": "ok"}},
        }
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [SimpleNamespace(type="ai", content="批量完成")]}},
        }


class _WriteIntentAgent:
    """写入意图文件，验证预览事件不提前 bump revision。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id

    async def astream_events(self, inputs, version, config):
        del inputs, version, config
        yield {
            "event": "on_tool_start",
            "name": "write_file",
            "run_id": "w1",
            "parent_ids": [],
            "data": {"input": {"path": "/project/intent.md", "content": "新意图"}},
        }
        self.store.set_text(self.project_id, "intent", "新意图")
        yield {
            "event": "on_tool_end",
            "name": "write_file",
            "run_id": "w1",
            "parent_ids": [],
            "data": {"output": "ok"},
        }
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [SimpleNamespace(type="ai", content="已写入")]}},
        }


class _InvalidWorldAgent:
    """写入无法解析的 world.json，预览应拒绝刷新。"""

    def __init__(self, store: ProjectStore, project_id: str):
        self.store = store
        self.project_id = project_id
        self.seen_messages: list = []

    async def astream_events(self, inputs, version, config):
        del version, config
        self.seen_messages.append(list(inputs.get("messages") or []))
        yield {
            "event": "on_tool_start",
            "name": "write_file",
            "run_id": "bad-world",
            "parent_ids": [],
            "data": {"input": {"path": "/project/world.json"}},
        }
        self.store.data_file(self.project_id, "world").write_text("{", encoding="utf-8")
        yield {
            "event": "on_tool_end",
            "name": "write_file",
            "run_id": "bad-world",
            "parent_ids": [],
            "data": {"output": "ok"},
        }
        yield {
            "event": "on_chain_end",
            "parent_ids": [],
            "data": {"output": {"messages": [SimpleNamespace(type="ai", content="尝试写入")]}},
        }


def _message_texts(items) -> str:
    """把会话或 Agent 输入里的消息拼成可检索文本。"""
    parts = []
    for item in items or []:
        if isinstance(item, dict):
            parts.append(str(item.get("content", "")))
            continue
        parts.append(str(getattr(item, "content", item)))
    return "\n".join(parts)


def _serialize_checks() -> None:
    """敏感字段打码，路径映射到自然内容类型。"""
    payload = serialize_trace_payload({"path": "/project/world.json", "api_key": "secret-value"})
    _expect(payload["api_key"] == "***", "轨迹序列化隐藏密钥")
    _expect(
        path_to_preview_target("/project/scenes/ev-1.json")
        == {"data_type": "scenes", "event_id": "ev-1"},
        "情节路径映射到 event_id",
    )
    _expect(
        path_to_preview_target("/project/outline.md") == {"data_type": "outline"},
        "大纲路径映射到 outline",
    )


async def _main_tree_check(workspace: Path) -> None:
    """主 Agent 多步工具挂在根步骤下，过程文本不作为最终答复。"""
    store = ProjectStore(workspace)
    project = store.create_project("主过程树")
    session = ProjectSession(store, project.id, agent=_MainMultiToolAgent(), max_repair=0)
    session._begin_turn()
    events = [event async for event in session._astream_agent()]
    session._end_turn()
    starts = [event.data for event in events if event.type == "tool_start"]
    texts = [event for event in events if event.type == "agent_text"]
    _expect(
        [item["step_id"] for item in starts] == ["read-a", "write-b"],
        "主 Agent 连续工具保留独立 step_id",
    )
    root_id = session._root_step_id
    _expect(
        all(item["parent_step_id"] == root_id for item in starts),
        "主 Agent 直接工具挂在根步骤下",
    )
    _expect(texts and all(item.data.get("text") == "过程文本" for item in texts), "过程文本写入 agent_text")
    _expect(
        all(item.data.get("step_id") == root_id for item in texts),
        "主 Agent 过程文本挂在根步骤",
    )
    sequences = [event.data.get("sequence") for event in events]
    _expect(sequences == sorted(sequences) and len(set(sequences)) == len(sequences), "sequence 回合内单调且不重复")
    _expect(all(event.data.get("turn_id") for event in events), "过程事件带 turn_id")


async def _nested_worker_check(workspace: Path) -> None:
    """批量情节 worker 的文本和工具调用挂到父步骤。"""
    store = ProjectStore(workspace)
    project = store.create_project("批量轨迹")
    session = ProjectSession(store, project.id, agent=_NestedWorkerAgent(), max_repair=0)
    session._begin_turn()
    events = [event async for event in session._astream_agent()]
    session._end_turn()
    types = [event.type for event in events]
    _expect("agent_text" in types and types.count("tool_start") >= 2, "worker 事件进入主回合队列")
    worker_start = next(
        event.data for event in events
        if event.type == "tool_start" and event.data.get("step_id") == "worker-write"
    )
    _expect(worker_start.get("parent_step_id") == "batch", "worker 写入挂到批量父步骤")
    worker_text = next(event.data for event in events if event.type == "agent_text")
    _expect(worker_text.get("parent_step_id") == "batch", "worker 文本挂到批量父步骤")


async def _preview_revision_check(workspace: Path) -> None:
    """写入成功后发出预览，当时不 bump revision；非法 JSON 不广播坏预览。"""
    store = ProjectStore(workspace)
    project = store.create_project("预览版本")
    session = ProjectSession(
        store,
        project.id,
        agent=_WriteIntentAgent(store, project.id),
        max_repair=0,
    )
    rev_before = store.load_meta(project.id).revisions.get("intent", 0)
    preview_rev = None
    events = []
    async for event in session.astream_turn("写意图"):
        if event.type == "data_preview_published":
            preview_rev = store.load_meta(project.id).revisions.get("intent", 0)
        events.append(event)
    preview = [event for event in events if event.type == "data_preview_published"]
    _expect(len(preview) == 1, "合法写入在检查点发布一代预览")
    _expect(preview[0].data.get("source") == "agent_preview", "预览来源标记为 agent_preview")
    _expect(preview_rev == rev_before, "预览时不增加 revision")
    _expect(store.load_meta(project.id).revisions.get("intent", 0) == rev_before + 1, "正式收口后才 bump revision")

    bad_session = ProjectSession(
        store,
        project.id,
        agent=_InvalidWorldAgent(store, project.id),
        max_repair=0,
    )
    bad_events = [event async for event in bad_session.astream_turn("写世界")]
    _expect(
        not any(event.type == "data_preview_published" for event in bad_events),
        "非法 JSON 不广播预览",
    )
    _expect(
        any(
            event.type == "status" and event.data.get("phase") == "checkpoint_invalid"
            for event in bad_events
        ),
        "非法检查点不抬升预览代次",
    )
    invalid_status = next(
        event.data
        for event in bad_events
        if event.type == "status" and event.data.get("phase") == "checkpoint_invalid"
    )
    _expect(invalid_status.get("audience") == "user", "检查点失败 status 受众为 user")
    _expect(invalid_status.get("code") == "checkpoint_invalid", "检查点失败带稳定 code")
    _expect("errors" not in invalid_status, "用户 status 不含逐片段错误")
    _expect(
        "上一有效版本" in (invalid_status.get("text") or ""),
        "用户看到中性的上一有效版本说明",
    )


async def _status_audience_check(workspace: Path) -> None:
    """内部 [系统状态] 进入 Agent 上下文，但不产生 SSE status。"""
    store = ProjectStore(workspace)
    project = store.create_project("状态分流")
    agent = _MainMultiToolAgent()
    session = ProjectSession(store, project.id, agent=agent, max_repair=0)
    internal = (
        "[系统状态] 当前保存版本已有仍然有效的正式检测报告："
        "状态 incomplete，问题 16 项。先调用 read_latest_state_validation。"
    )
    session._build_status_note = lambda: internal  # type: ignore[method-assign]
    events = [event async for event in session.astream_turn("继续")]
    fed = "\n".join(_message_texts(batch) for batch in agent.seen_messages)
    _expect(internal in fed, "内部系统状态进入 Agent 上下文")
    _expect(
        not any(
            event.type == "status" and "[系统状态]" in str(event.data.get("text", ""))
            for event in events
        ),
        "内部系统状态不作为 SSE status 发出",
    )


async def _checkpoint_agent_feedback_check(workspace: Path) -> None:
    """检查点失败的详细错误走 Agent 修复通道，不进用户 status。"""
    payload = checkpoint_invalid_user_status()
    _expect(payload["audience"] == "user", "用户载荷受众为 user")
    _expect("errors" not in payload, "用户载荷不含 errors")
    feedback = _format_checkpoint_feedback({"world": "JSON 无法解析"})
    _expect("[系统校验]" in feedback and "world" in feedback, "子任务反馈含逐片段错误")

    store = ProjectStore(workspace)
    project = store.create_project("检查点修复通道")
    agent = _InvalidWorldAgent(store, project.id)
    session = ProjectSession(store, project.id, agent=agent, max_repair=1)
    events = [event async for event in session.astream_turn("写世界")]
    fed = "\n".join(_message_texts(batch) for batch in agent.seen_messages)
    _expect(len(agent.seen_messages) >= 2, "校验失败后应再跑一轮修复 Agent")
    _expect("[系统校验]" in fed, "详细检查点错误注入 Agent [系统校验]")
    _expect(
        not any(event.type == "status" and event.data.get("errors") for event in events),
        "SSE status 不含错误字典",
    )


def main() -> int:
    """在临时工作区执行轨迹与预览检查。"""
    workspace = Path(tempfile.mkdtemp(prefix="nf_execution_trace_"))
    print("── Agent 执行轨迹与预览检查")
    try:
        _serialize_checks()
        asyncio.run(_main_tree_check(workspace / "main"))
        asyncio.run(_nested_worker_check(workspace / "nested"))
        asyncio.run(_preview_revision_check(workspace / "preview"))
        asyncio.run(_status_audience_check(workspace / "status"))
        asyncio.run(_checkpoint_agent_feedback_check(workspace / "feedback"))
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
