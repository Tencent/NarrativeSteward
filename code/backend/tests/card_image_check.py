"""卡片 AI 生图离线检查：提示词、资产落盘与 Agent 挂载（不调用真实模型）。"""

from __future__ import annotations

import asyncio
import base64
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from narrative_forge.agents.card_image_tool import build_card_image_tool
from narrative_forge.core.card_image_service import (
    CardImageGenerationError,
    build_card_image_prompt,
    generate_card_image_asset,
)
from narrative_forge.core.store import ProjectStore

_PNG = b"\x89PNG\r\n\x1a\nfake-image-bytes"


class _FakeImages:
    """记录调用参数并返回固定 Base64 PNG 的 Images API 替身。"""

    def __init__(self, encoded: str | None = None):
        self.encoded = encoded if encoded is not None else base64.b64encode(_PNG).decode()
        self.calls: list[dict] = []

    def generate(self, **kwargs):
        """模拟 ``client.images.generate``。"""
        self.calls.append(kwargs)
        return SimpleNamespace(data=[SimpleNamespace(b64_json=self.encoded)])


class _FakeClient:
    """只暴露测试所需 ``images`` 属性的 OpenAI 客户端替身。"""

    def __init__(self, encoded: str | None = None):
        self.images = _FakeImages(encoded)


def _assert(condition: bool, message: str) -> None:
    """失败时给出明确测试说明。"""
    if not condition:
        raise AssertionError(message)


def main() -> int:
    """运行全部离线检查并返回进程退出码。"""
    character_prompt = build_card_image_prompt(
        "characters",
        name="荒原兽王",
        description="巨兽与部族图腾的结合体",
        tags=["兽王", "烬月神域"],
        visual_instructions="不要画成人形",
    )
    location_prompt = build_card_image_prompt(
        "locations",
        name="失名神庙",
        description="被灰白潮汐侵蚀的神庙",
    )
    _assert("全身角色立绘" in character_prompt and "不要画成人形" in character_prompt, "角色提示词不完整")
    _assert("横向环境背景图" in location_prompt and "16:9" in location_prompt, "地点提示词不完整")

    workspace = Path(tempfile.mkdtemp(prefix="nf_card_image_"))
    store = ProjectStore(workspace)
    meta = store.create_project("生图自测")
    store.set_data(
        meta.id,
        "world",
        {
            "characters": [
                {
                    "id": "char-1",
                    "name": "荒原兽王",
                    "description": "巨兽与图腾结合体",
                    "tags": ["兽王"],
                    "image": "",
                }
            ]
        },
    )

    client = _FakeClient()
    with patch.dict(
        os.environ,
        {
            "IMAGE_MODEL": "gpt-image-2",
            "IMAGE_SIZE": "1024x1024",
            "IMAGE_CHARACTER_MODEL": "gpt-image-1",
            "IMAGE_CHARACTER_SIZE": "1024x1536",
            "IMAGE_CHARACTER_BACKGROUND": "transparent",
        },
    ):
        generated = generate_card_image_asset(
            store,
            meta.id,
            category="characters",
            name="荒原兽王",
            description="巨兽与图腾结合体",
            image_client=client,
        )
    path = store.asset_path(meta.id, generated.name)
    _assert(path is not None and path.read_bytes() == _PNG, "生成图片没有正确落盘")
    _assert(client.images.calls[0]["model"] == "gpt-image-1", "角色模型覆盖未生效")
    _assert(client.images.calls[0]["size"] == "1024x1536", "角色竖版尺寸未生效")
    _assert(client.images.calls[0]["background"] == "transparent", "角色透明背景未生效")
    _assert(client.images.calls[0]["output_format"] == "png", "角色输出未固定为 PNG")

    bad_client = _FakeClient(encoded="not-base64")
    try:
        generate_card_image_asset(
            store,
            meta.id,
            category="characters",
            name="坏响应",
            image_client=bad_client,
        )
    except CardImageGenerationError:
        pass
    else:
        raise AssertionError("非法 Base64 响应未被拒绝")

    tool = build_card_image_tool(store, meta.id)
    revision_before = store.load_meta(meta.id).revisions.get("world", 0)

    async def fake_generate(*_args, **_kwargs):
        """测试替身：跳过真实生图，直接返回已落盘资产。"""
        return generated

    with patch(
        "narrative_forge.agents.card_image_tool.agenerate_card_image_asset",
        new=fake_generate,
    ):
        result = asyncio.run(
            tool.ainvoke(
                {
                    "category": "characters",
                    "card_id": "char-1",
                    "visual_instructions": "突出图腾",
                    "replace_existing": False,
                }
            )
        )
    _assert(result["ok"], f"Agent 生图工具失败：{result}")
    world = store.get_data(meta.id, "world") or {}
    _assert(world["characters"][0]["image"] == generated.path, "Agent 工具未挂载卡片图片")
    _assert(
        store.load_meta(meta.id).revisions.get("world", 0) == revision_before,
        "Agent 工具不应自行登记 world revision",
    )

    blocked = asyncio.run(
        tool.ainvoke(
            {
                "category": "characters",
                "card_id": "char-1",
                "replace_existing": False,
            }
        )
    )
    _assert(blocked["status"] == "already_has_image", "已有配图未被默认覆盖保护")

    print("PASS card image checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
