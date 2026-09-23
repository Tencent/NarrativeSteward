"""当前 Agent 回合的轨迹上下文：嵌套事件队列、根步骤和预算标志。

子 Agent 与 middleware 产生的过程事件不会全部出现在主图 ``astream_events`` 中，
因此通过上下文变量把嵌套事件送回正在消费的回合。预算 middleware 也用同一通道发出收口提示。
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from narrative_forge.orchestrator.session import TurnEvent

# 当前回合的嵌套事件队列。元素为 TurnEvent，或结束哨兵 None。
nested_event_queue: ContextVar[asyncio.Queue | None] = ContextVar(
    "nested_event_queue",
    default=None,
)
# 当前正在运行的 task 步骤 id，供嵌套图事件挂父节点。
active_batch_step_id: ContextVar[str | None] = ContextVar(
    "active_batch_step_id",
    default=None,
)
# 本轮已发出的预算档位，避免 75/90 重复注入。
budget_notices: ContextVar[set[str] | None] = ContextVar(
    "budget_notices",
    default=None,
)
# 本轮是否已经强制收口（用于跳过自动修复）。
budget_force_closed: ContextVar[bool] = ContextVar("budget_force_closed", default=False)


def emit_nested_event(event: TurnEvent) -> None:
    """把嵌套图或 middleware 产生的过程事件送进当前回合队列。

    若当前不在带队列的回合中，静默丢弃，避免工具在 CLI 非流式路径上报错。
    """
    queue = nested_event_queue.get()
    if queue is None:
        return
    queue.put_nowait(("nested", event))
