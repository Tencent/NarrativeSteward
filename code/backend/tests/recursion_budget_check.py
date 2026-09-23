"""离线检查：75 软收口、90 强制收口、100 仍走硬上限配置。"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import HumanMessage, SystemMessage

from narrative_forge.agents.recursion_budget import (
    RECURSION_FORCE_CLOSE,
    RECURSION_LIMIT,
    RECURSION_SOFT_CLOSE,
    RecursionBudgetMiddleware,
    recursion_config,
)
from narrative_forge.orchestrator.trace_context import budget_force_closed, budget_notices


def _expect(condition: bool, message: str) -> None:
    """断言条件成立；失败则退出。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


class _FakeRequest:
    """最小 ModelRequest 替身，只实现 middleware 用到的字段和 override。"""

    def __init__(self, tools):
        self.tools = list(tools)
        self.messages = []
        self.system_message = SystemMessage(content="base")
        self.runtime = None

    def override(self, **kwargs):
        """按 LangChain ModelRequest.override 语义覆盖字段并返回自身。"""
        for key, value in kwargs.items():
            setattr(self, key, value)
        return self


def _tool(name: str) -> SimpleNamespace:
    """构造带 name 的假工具。"""
    return SimpleNamespace(name=name)


def main() -> int:
    """检查三档预算行为，不启动真实 LangGraph。"""
    print("── 递归预算收口检查")
    _expect(RECURSION_SOFT_CLOSE == 75, "软收口步数为 75")
    _expect(RECURSION_FORCE_CLOSE == 90, "强制收口步数为 90")
    _expect(RECURSION_LIMIT == 100, "硬上限为 100")
    _expect(recursion_config() == {"recursion_limit": 100}, "invoke 配置带 recursion_limit=100")

    middleware = RecursionBudgetMiddleware()
    tools = [_tool("write_file"), _tool("task")]

    budget_notices.set(set())
    budget_force_closed.set(False)
    with patch(
        "narrative_forge.agents.recursion_budget.current_graph_step",
        return_value=RECURSION_SOFT_CLOSE,
    ):
        first = middleware._apply_budget(_FakeRequest(tools))
        second = middleware._apply_budget(_FakeRequest(tools))
    names = [_tool_name(item) for item in first.tools]
    _expect("write_file" in names, "75 步仍保留写入工具")
    _expect("task" not in names, "75 步禁止开启新层级")
    soft_messages = [msg for msg in first.messages if isinstance(msg, HumanMessage)]
    _expect(len(soft_messages) == 1, "75 步只注入一次软收口说明")
    _expect(
        not any(isinstance(msg, HumanMessage) for msg in second.messages),
        "同一回合第二次到达 75 步不再重复注入",
    )
    _expect(budget_force_closed.get() is False, "75 步不标记强制收口")

    budget_notices.set(set())
    budget_force_closed.set(False)
    with patch(
        "narrative_forge.agents.recursion_budget.current_graph_step",
        return_value=RECURSION_FORCE_CLOSE,
    ):
        forced = middleware._apply_budget(_FakeRequest(tools))
    _expect(forced.tools == [], "90 步移除全部工具")
    _expect(budget_force_closed.get() is True, "90 步标记强制收口")
    _expect("不要再调用任何工具" in str(forced.system_message.content), "90 步要求只汇报进度")

    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


def _tool_name(tool) -> str:
    """读取假工具名称。"""
    return str(getattr(tool, "name", "") or "")


if __name__ == "__main__":
    sys.exit(main())
