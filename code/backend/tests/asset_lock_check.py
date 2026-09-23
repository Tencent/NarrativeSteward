"""面板配图上传/生图占用项目锁，并在成功或失败后释放。

离线，不调用真实生图模型。用法::

    python tests/asset_lock_check.py
"""

from __future__ import annotations

import asyncio
import base64
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

_TMP_WS = Path(tempfile.mkdtemp(prefix="nf_asset_lock_"))
os.environ["NARRATIVE_FORGE_WORKSPACE"] = str(_TMP_WS)

from httpx import ASGITransport, AsyncClient  # noqa: E402

from narrative_forge.api.app import create_app  # noqa: E402
from narrative_forge.core.card_image_service import (  # noqa: E402
    CardImageConfigurationError,
    CardImageGenerationError,
)

_PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n0123456789").decode()
_GENERATED = SimpleNamespace(
    name="generated-lock.png",
    path="assets/generated-lock.png",
    model="gpt-image-2",
    size="1024x1024",
    background="opaque",
)


def _fail(message: str) -> None:
    """统一失败信息。"""
    raise AssertionError(message)


async def _client(app):
    """打开不跟随时长限制的 ASGI 客户端。"""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _create_project(client: AsyncClient) -> str:
    """新建项目并返回 id。"""
    response = await client.post("/api/projects", json={"name": "配图锁自测"})
    if response.status_code != 201:
        _fail(f"create project -> {response.status_code} {response.text}")
    return response.json()["id"]


async def test_generate_holds_and_releases_lock(app) -> None:
    """生图进行中项目 busy，Agent 409、写入 423；结束后释放。"""
    async with await _client(app) as client:
        pid = await _create_project(client)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def slow_generate(*_args, **_kwargs):
            entered.set()
            await release.wait()
            return _GENERATED

        with patch(
            "narrative_forge.api.routes.agenerate_card_image_asset",
            side_effect=slow_generate,
        ):
            task = asyncio.create_task(
                client.post(
                    f"/api/projects/{pid}/assets/generate",
                    json={"category": "characters", "name": "林恩"},
                )
            )
            await asyncio.wait_for(entered.wait(), timeout=2)
            state = await client.get(f"/api/projects/{pid}")
            if state.json().get("busy") is not True:
                _fail("generate should set project busy")
            chat = await client.post(f"/api/projects/{pid}/chat", json={"message": "hi"})
            if chat.status_code != 409:
                _fail(f"busy generate -> chat {chat.status_code}")
            write = await client.put(
                f"/api/projects/{pid}/data/intent",
                json={"content": "x", "base_revision": 0},
            )
            if write.status_code != 423:
                _fail(f"busy generate -> put {write.status_code}")
            upload = await client.post(
                f"/api/projects/{pid}/assets",
                json={"filename": "hero.png", "data_b64": _PNG_B64},
            )
            if upload.status_code != 423:
                _fail(f"busy generate -> upload {upload.status_code}")
            release.set()
            generated = await task
        if generated.status_code != 201:
            _fail(f"generate should succeed after wait -> {generated.status_code}")
        idle = await client.get(f"/api/projects/{pid}")
        if idle.json().get("busy"):
            _fail("successful generate must release lock")


async def test_upload_releases_lock(app) -> None:
    """上传成功后释放锁；已忙时新的上传返回 423。"""
    async with await _client(app) as client:
        pid = await _create_project(client)
        uploaded = await client.post(
            f"/api/projects/{pid}/assets",
            json={"filename": "hero.png", "data_b64": _PNG_B64},
        )
        if uploaded.status_code != 201:
            _fail(f"upload should succeed -> {uploaded.status_code} {uploaded.text}")
        idle = await client.get(f"/api/projects/{pid}")
        if idle.json().get("busy"):
            _fail("successful upload must release lock")
        app.state.locks._busy.add(pid)
        blocked = await client.post(
            f"/api/projects/{pid}/assets",
            json={"filename": "other.png", "data_b64": _PNG_B64},
        )
        if blocked.status_code != 423:
            _fail(f"busy project -> upload {blocked.status_code}")
        app.state.locks._busy.discard(pid)


async def test_failures_release_lock(app) -> None:
    """校验失败、配置错误、模型错误后都不得留下 busy。"""
    async with await _client(app) as client:
        pid = await _create_project(client)
        invalid = await client.post(
            f"/api/projects/{pid}/assets/generate",
            json={"category": "factions", "name": "非法分类"},
        )
        if invalid.status_code != 422:
            _fail(f"unsupported category -> {invalid.status_code}")
        if (await client.get(f"/api/projects/{pid}")).json().get("busy"):
            _fail("422 generate must release lock")

        with patch(
            "narrative_forge.api.routes.agenerate_card_image_asset",
            new_callable=AsyncMock,
            side_effect=CardImageConfigurationError("未配置生图"),
        ):
            config_err = await client.post(
                f"/api/projects/{pid}/assets/generate",
                json={"category": "locations", "name": "旧钟楼"},
            )
        if config_err.status_code != 503:
            _fail(f"config error -> {config_err.status_code}")
        if (await client.get(f"/api/projects/{pid}")).json().get("busy"):
            _fail("503 generate must release lock")

        with patch(
            "narrative_forge.api.routes.agenerate_card_image_asset",
            new_callable=AsyncMock,
            side_effect=CardImageGenerationError("模型失败"),
        ):
            model_err = await client.post(
                f"/api/projects/{pid}/assets/generate",
                json={"category": "locations", "name": "旧钟楼"},
            )
        if model_err.status_code != 502:
            _fail(f"model error -> {model_err.status_code}")
        if (await client.get(f"/api/projects/{pid}")).json().get("busy"):
            _fail("502 generate must release lock")

        bad_upload = await client.post(
            f"/api/projects/{pid}/assets",
            json={"filename": "hero.bmp", "data_b64": _PNG_B64},
        )
        if bad_upload.status_code != 422:
            _fail(f"bad upload type -> {bad_upload.status_code}")
        if (await client.get(f"/api/projects/{pid}")).json().get("busy"):
            _fail("422 upload must release lock")


async def main_async() -> None:
    """顺序跑完全部锁生命周期断言。"""
    app = create_app()
    await test_generate_holds_and_releases_lock(app)
    await test_upload_releases_lock(app)
    await test_failures_release_lock(app)


def main() -> int:
    """脚本入口。"""
    asyncio.run(main_async())
    print("PASS asset lock checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
