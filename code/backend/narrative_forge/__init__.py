"""narrative_forge —— 交互叙事游戏生成工具的后端核心包。

分层（见 docs/DESIGN.md §6.2 / §9）：
- ``core``         无头核心：数据模型、项目存储、校验
- ``agents``       Deep Agents：主对话 Agent + 各阶段 sub-agent + 共享工具
- ``skills``       SKILL.md 技能包（渐进式加载）
- ``orchestrator`` 编排（任务/锁/事件）—— 后续实现
- ``api``          FastAPI（REST + SSE）—— 后续实现
"""

__version__ = "0.1.0"
