"""递归预算收口：在 LangGraph super-step 接近上限时主动结束，而不是撞硬限制。

75 步软收口：去掉会开启新层级的工具（子 Agent、批量情节），保留文件工具以写完当前产物。
90 步强制收口：清空全部工具，只允许模型用文字报告已完成和未完成内容。
100 步仍由 LangGraph ``recursion_limit`` 抛错，走整轮回滚。
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from narrative_forge.orchestrator.trace_context import (
    budget_force_closed,
    budget_notices,
    emit_nested_event,
)

# 与 session 中的 invoke config 保持一致。
RECURSION_LIMIT = 100
RECURSION_SOFT_CLOSE = 75
RECURSION_FORCE_CLOSE = 90

_SOFT_INSTRUCTION = (
    "[系统预算] 执行规模较大，请完成当前正在写入的产物后停止。"
    "不要启动新的子任务，也不要开始新的创作层级。"
    "完成后用中文说明已经完成的内容、尚未完成的内容和检查情况。"
)
_FORCE_INSTRUCTION = (
    "[系统预算] 执行步数即将用尽。不要再调用任何工具。"
    "用中文直接说明已经完成的内容、尚未完成的内容和检查情况。"
)
_NEW_LAYER_TOOLS = {"task"}


def current_graph_step(runtime: Any | None = None) -> int:
    """读取 LangGraph 当前 super-step；读不到时当作 0，不误触发收口。"""
    metadata = None
    if runtime is not None:
        execution = getattr(runtime, "execution_info", None)
        metadata = getattr(execution, "metadata", None)
    if not isinstance(metadata, dict):
        try:
            from langgraph.config import get_config

            config = get_config()
            metadata = (config or {}).get("metadata") if isinstance(config, dict) else None
        except Exception:
            metadata = None
    if not isinstance(metadata, dict):
        return 0
    raw = metadata.get("langgraph_step")
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def _tool_name(tool: Any) -> str:
    """取出工具名，兼容 BaseTool 与 dict 声明。"""
    if isinstance(tool, dict):
        return str(tool.get("name") or "")
    return str(getattr(tool, "name", "") or "")


def _append_instruction(request: ModelRequest, text: str) -> ModelRequest:
    """把预算指令追加到当前请求的系统说明之后，不改用户可见对话历史。"""
    current = request.system_message
    if isinstance(current, SystemMessage):
        content = f"{current.content}\n\n{text}"
        system = SystemMessage(content=content)
    elif isinstance(current, str) and current.strip():
        system = SystemMessage(content=f"{current}\n\n{text}")
    else:
        system = SystemMessage(content=text)
    return request.override(system_message=system)


class RecursionBudgetMiddleware(AgentMiddleware):
    """在每次模型调用前按图步数切换软收口或强制收口。"""

    def wrap_model_call(self, request, handler):
        """同步模型调用：先按预算改请求，再交给后续中间件或模型。"""
        return handler(self._apply_budget(request))

    async def awrap_model_call(self, request, handler):
        """异步模型调用，语义与同步版本相同。"""
        return await handler(self._apply_budget(request))

    def _apply_budget(self, request: ModelRequest) -> ModelRequest:
        """按当前 super-step 限制工具并在档位首次触发时发出状态事件。"""
        from narrative_forge.orchestrator.session import TurnEvent
        from narrative_forge.orchestrator.turn_control import get_turn_stop

        controller = get_turn_stop()
        if controller is not None and controller.is_stopped():
            return request

        step = current_graph_step(getattr(request, "runtime", None))
        notices = budget_notices.get()
        if notices is None:
            notices = set()
            budget_notices.set(notices)

        if step >= RECURSION_FORCE_CLOSE:
            if "force" not in notices:
                notices.add("force")
                budget_force_closed.set(True)
                emit_nested_event(
                    TurnEvent(
                        "budget_status",
                        {
                            "level": "force",
                            "step": step,
                            "limit": RECURSION_LIMIT,
                            "message": "执行步数即将用尽，正在结束本轮并汇报进度",
                        },
                    )
                )
            request = request.override(tools=[])
            return _append_instruction(request, _FORCE_INSTRUCTION)

        if step >= RECURSION_SOFT_CLOSE:
            if "soft" not in notices:
                notices.add("soft")
                emit_nested_event(
                    TurnEvent(
                        "budget_status",
                        {
                            "level": "soft",
                            "step": step,
                            "limit": RECURSION_LIMIT,
                            "message": "执行规模较大，正在完成当前产物并收口",
                        },
                    )
                )
                request = request.override(
                    messages=[*list(request.messages), HumanMessage(content=_SOFT_INSTRUCTION)]
                )
            filtered = [
                tool
                for tool in (request.tools or [])
                if _tool_name(tool) not in _NEW_LAYER_TOOLS
            ]
            return request.override(tools=filtered)

        return request


def recursion_config() -> dict[str, int]:
    """供 ``invoke`` / ``astream_events`` 使用的图递归上限。"""
    return {"recursion_limit": RECURSION_LIMIT}
