"""主对话 Agent 的构建入口。

按 §3.1 的混合架构：一个主对话 Agent（项目级 session）+ 各阶段 sub-agent。
主 Agent 负责对话与路由，重活通过内置 task() 委派给 sub-agent；数据读写一律走
内置文件工具 + CompositeBackend（见 agents/backends.py）。
"""

from __future__ import annotations

from deepagents import create_deep_agent

from narrative_forge import config
from narrative_forge.agents import prompts
from narrative_forge.agents.backends import build_project_backend, creative_file_permissions
from narrative_forge.agents.turn_control_middleware import agent_middleware
from narrative_forge.agents.card_image_tool import build_card_image_tool
from narrative_forge.agents.subagents import build_subagents
from narrative_forge.agents.validation_tool import (
    build_latest_validation_tool,
    build_state_validation_tool,
)
from narrative_forge.core.store import ProjectStore


def build_main_agent(
    project_id: str,
    store: ProjectStore | None = None,
    model=None,
    use_skills: bool = True,
    locale: str = "zh-CN",
):
    """构建绑定到某个项目的主对话 Agent。

    Args:
        project_id: 当前会话操作的项目 id。
        store: 项目存储；缺省时按配置在默认工作区创建。
        model: LangChain ChatModel；缺省时按 ``.env`` 配置自动构建。
        use_skills: 是否为 sub-agent 挂载 skills。
        locale: 自然语言回复语言；缺省为中文。

    Returns:
        一个已编译的 deep agent（可用 ``.invoke`` / ``.stream_events`` 运行）。
        文件后端绑定到该项目目录；sub-agent 自动共享同一后端。
    """
    store = store or ProjectStore(config.get_workspace())
    model = model or config.build_chat_model()

    backend = build_project_backend(store, project_id)
    subagents = build_subagents(use_skills=use_skills, locale=locale)

    return create_deep_agent(
        model=model,
        system_prompt=prompts.main_agent_prompt(locale),
        subagents=subagents,
        backend=backend,
        permissions=creative_file_permissions(),
        middleware=agent_middleware(),
        tools=[
            build_latest_validation_tool(store, project_id),
            build_state_validation_tool(store, project_id),
            build_card_image_tool(store, project_id),
        ],
        name="main-agent",
    )
