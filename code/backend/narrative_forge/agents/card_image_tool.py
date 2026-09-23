"""主 Agent 的角色/地点卡片生图工具。"""

from __future__ import annotations

from copy import deepcopy
from typing import Literal

from langchain_core.tools import tool

from narrative_forge.core.card_image_service import (
    CardImageCancelled,
    CardImageConfigurationError,
    CardImageGenerationError,
    agenerate_card_image_asset,
)
from narrative_forge.core.store import ProjectStore
from narrative_forge.core.validation import validate_data
from narrative_forge.orchestrator.turn_control import AgentTurnStopped, get_turn_stop


def build_card_image_tool(store: ProjectStore, project_id: str):
    """构建绑定项目的 ``generate_card_image`` 高层工具。

    Args:
        store: 项目存储。
        project_id: 当前主 Agent 所属项目。

    Returns:
        一个只要求稳定卡片 id 与视觉要求、自动完成生图和卡片挂载的 LangChain 工具。
        工具不登记 revision；Agent 回合末的统一校验收口会识别 ``world.json`` 变化并登记一次。
    """

    @tool("generate_card_image")
    async def generate_card_image(
        category: Literal["characters", "locations"],
        card_id: str,
        visual_instructions: str = "",
        replace_existing: bool = False,
    ) -> dict:
        """仅当用户明确要求为角色或地点生成配图时调用。

        你必须先读取当前世界设定，把用户提到的名称解析成唯一稳定卡片 id；有多个可能对象时先询问。
        ``category`` 只能是 ``characters`` 或 ``locations``。默认不覆盖已有图片；只有用户明确要求
        重画/替换时才把 ``replace_existing`` 设为 true。你只负责确定目标和补充视觉要求，不要自己
        拼接文件路径、解码图片或直接编辑卡片 image。
        """
        world = store.get_data(project_id, "world")
        if not isinstance(world, dict):
            return {
                "ok": False,
                "status": "world_missing",
                "message": "当前项目尚无可用的世界设定。",
            }
        cards = world.get(category)
        if not isinstance(cards, list):
            return {
                "ok": False,
                "status": "category_missing",
                "message": "当前世界设定中没有该类卡片。",
            }
        card = next(
            (
                item
                for item in cards
                if isinstance(item, dict) and str(item.get("id", "")) == card_id
            ),
            None,
        )
        if card is None:
            return {
                "ok": False,
                "status": "card_not_found",
                "message": f"没有找到卡片 id：{card_id}",
            }
        previous_image = str(card.get("image") or "")
        if previous_image and not replace_existing:
            return {
                "ok": False,
                "status": "already_has_image",
                "card_id": card_id,
                "card_name": card.get("name", ""),
                "message": "该卡片已有配图；只有用户明确要求重画或替换时才能覆盖。",
            }

        controller = get_turn_stop()
        if controller is not None:
            controller.raise_if_stopped()

        try:
            generated = await agenerate_card_image_asset(
                store,
                project_id,
                category=category,
                name=str(card.get("name") or ""),
                description=str(card.get("description") or ""),
                tags=card.get("tags") if isinstance(card.get("tags"), list) else [],
                visual_instructions=visual_instructions,
                cancel_event=(
                    controller.cancel_event() if controller is not None else None
                ),
            )
        except CardImageCancelled:
            raise AgentTurnStopped() from None
        except CardImageConfigurationError as exc:
            return {
                "ok": False,
                "status": "not_configured",
                "message": str(exc),
            }
        except (CardImageGenerationError, ValueError) as exc:
            return {
                "ok": False,
                "status": "generation_failed",
                "message": str(exc),
            }

        if controller is not None:
            controller.raise_if_stopped()

        patched = deepcopy(world)
        patched_cards = patched.get(category) or []
        patched_card = next(
            (
                item
                for item in patched_cards
                if isinstance(item, dict) and str(item.get("id", "")) == card_id
            ),
            None,
        )
        try:
            if patched_card is None:
                raise RuntimeError("生图期间目标卡片已不存在")
            patched_card["image"] = generated.path
            ok, message = validate_data("world", patched)
            if not ok:
                raise RuntimeError(f"更新后的世界设定校验失败：{message}")
            store.set_data(project_id, "world", patched)
        except Exception as exc:
            store.delete_asset(project_id, generated.name)
            return {
                "ok": False,
                "status": "attach_failed",
                "message": str(exc),
            }

        return {
            "ok": True,
            "status": "generated",
            "category": category,
            "card_id": card_id,
            "card_name": card.get("name", ""),
            "image_path": generated.path,
            "model": generated.model,
            "size": generated.size,
            "background": generated.background,
            "replaced_existing": bool(previous_image),
            "message": "配图已生成并挂载到卡片；版本将在本轮结束时统一登记。",
        }

    return generate_card_image
