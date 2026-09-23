"""编排层：把 Agent 调用包装为带回合末校验、自动修复与版本登记的会话。

延迟导出会话类型，避免 ``trace_context`` / 预算 middleware 与 ``session`` 形成循环导入。
"""

from __future__ import annotations

__all__ = ["ProjectSession", "TurnEvent", "TurnResult"]


def __getattr__(name: str):
    """按需从 session 模块取出公开类型。"""
    if name in __all__:
        from narrative_forge.orchestrator import session as session_module

        return getattr(session_module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
