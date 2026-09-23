"""各阶段 sub-agent 的定义（dict 形式，供 create_deep_agent 的 subagents 参数）。

含四个：大纲（outline-writer）、世界设定（world-builder）、事件图（event-builder）、场景情节
（scene-builder）。它们都不声明自己的 ``tools``——这样会**继承内置文件工具**（read/write/edit/grep/ls），
由它们直接读写 ``/project/outline.md`` / ``/project/world.json`` / ``/project/events.json`` /
``/project/scenes/<event_id>.json``。每个子 Agent 通过 ``skills`` 加载技能。
"""

from __future__ import annotations

from narrative_forge.agents import prompts
from narrative_forge.agents.backends import SKILLS_SOURCE, creative_file_permissions
from narrative_forge.agents.turn_control_middleware import agent_middleware


def build_subagents(use_skills: bool = True, locale: str = "zh-CN") -> list[dict]:
    """构建 sub-agent 配置列表。

    Args:
        use_skills: 是否为子 Agent 挂载 skills（出问题时可关闭以排查）。
        locale: 自然语言回复语言；缺省为中文。

    Returns:
        可直接传给 ``create_deep_agent(subagents=...)`` 的 dict 列表。
    """
    outline_subagent = {
        "name": "outline-writer",
        "description": (
            "基于创作意图与素材生成或大幅重写【故事大纲】（弱格式自由 Markdown，故事整体走向），"
            "写入 /project/outline.md。当用户想生成大纲，或对大纲做较大调整时委派给它。"
        ),
        "system_prompt": prompts.outline_agent_prompt(locale),
        "tools": [],
        "permissions": creative_file_permissions(),
        "middleware": agent_middleware(),
    }
    world_subagent = {
        "name": "world-builder",
        "description": (
            "基于大纲与素材生成或大幅重写【世界设定】（分类卡片：世界观/角色/地点/势力/历史/其他），"
            "写入 /project/world.json。当用户想生成世界设定，或对其做较大改动时委派给它。"
        ),
        "system_prompt": prompts.world_agent_prompt(locale),
        "tools": [],
        "permissions": creative_file_permissions(),
        "middleware": agent_middleware(),
    }
    event_subagent = {
        "name": "event-builder",
        "description": (
            "基于大纲与世界设定生成或大幅重写【事件图】"
            "（全局状态变量 + 事件节点 + 带解锁条件的边），写入 /project/events.json。"
            "当用户想生成事件图，或对其做较大改动时委派给它。"
        ),
        "system_prompt": prompts.event_agent_prompt(locale),
        "tools": [],
        "permissions": creative_file_permissions(),
        "middleware": agent_middleware(),
    }
    scene_subagent = {
        "name": "scene-builder",
        "description": (
            "为用户指定的一个或多个事件生成或大幅重写其内部的【可玩情节图】"
            "（情节 beat + 带条件的边，effects 写状态，并为正式事件出口提供可实现的状态变化），"
            "写入 /project/scenes/<event_id>.json。"
            "一次委派即可读取事件图和全部已有情节，自主创建、调整或删除任意数量的情节文件；"
            "不要为每个事件再拆并行任务。委派时说明目标范围和用户要求即可。"
        ),
        "system_prompt": prompts.scene_agent_prompt(locale),
        "tools": [],
        "permissions": creative_file_permissions(),
        "middleware": agent_middleware(),
    }

    subagents = [outline_subagent, world_subagent, event_subagent, scene_subagent]
    if use_skills:
        # 经 /skills 路由读取技能根目录下的全部 SKILL.md（渐进式披露）。
        for sa in subagents:
            sa["skills"] = [SKILLS_SOURCE]

    return subagents
