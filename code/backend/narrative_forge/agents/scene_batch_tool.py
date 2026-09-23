"""已停用的多事件情节批次工具。

生产路径改为一次 ``task(subagent_type="scene-builder")``，由同一个 Scene Agent
读写全部相关 ``scenes/<event_id>.json``。本模块保留可导入的兼容入口，不再并行
启动 worker，也不写入项目文件。
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool

from narrative_forge.core.store import ProjectStore

_DEPRECATED = (
    "generate_scenes_batch 已停用。请改用一次 task(subagent_type='scene-builder')，"
    "在说明中列出全部目标事件，由同一个 Scene Agent 读写所有情节文件。"
)


def build_scene_batch_tool(store: ProjectStore, project_id: str, model: Any):
    """返回已停用的兼容工具；调用不读写项目、不启动并行 worker。"""
    del store, project_id, model

    @tool("generate_scenes_batch")
    async def generate_scenes_batch(
        event_ids: list[str],
        request: str = "",
        run_full_validation: bool = False,
    ) -> str:
        """已停用：请改用一次 scene-builder 子任务处理全部相关情节。"""
        del event_ids, request, run_full_validation
        return _DEPRECATED

    return generate_scenes_batch
