"""角色/地点卡片的共享 AI 生图服务。

面板按钮与主 Agent 都复用本模块完成提示词构建、OpenAI 兼容接口调用、Base64 解码和项目资产落盘。
本模块只生成资产，不直接修改 ``world.json``；不同入口按各自的草稿/revision 生命周期挂载图片。
Agent 回合停止时可取消尚未落盘的生图 HTTP；面板同步入口仍等待当前请求返回。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import inspect
from dataclasses import dataclass
from typing import Any

from narrative_forge import config
from narrative_forge.core.store import ProjectStore

CARD_IMAGE_CATEGORIES = ("characters", "locations")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class CardImageGenerationError(RuntimeError):
    """生图请求、返回内容或资产落盘不符合要求。"""


class CardImageConfigurationError(CardImageGenerationError):
    """生图所需的 ``IMAGE_*`` 配置缺失。"""


class CardImageCancelled(CardImageGenerationError):
    """生图 HTTP 在落盘前被取消，项目中未写入图片。"""


@dataclass(frozen=True)
class GeneratedCardImage:
    """一张已保存到项目配图库的生成图片。

    Attributes:
        name: ``assets/`` 下由存储层生成的唯一文件名。
        path: 卡片 ``image`` 字段使用的项目相对路径。
        prompt: 本次实际发送给生图模型的完整提示词，供测试和问题定位。
        model: 本次使用的生图模型名称。
        size: 本次请求的图片尺寸。
        background: 本次请求的背景模式；未指定时为 ``None``。
    """

    name: str
    path: str
    prompt: str
    model: str
    size: str
    background: str | None


def build_card_image_prompt(
    category: str,
    *,
    name: str,
    description: str = "",
    tags: list[str] | None = None,
    visual_instructions: str = "",
) -> str:
    """根据卡片数据构建角色立绘或地点背景提示词。

    Args:
        category: ``characters`` 或 ``locations``。
        name: 卡片名称。
        description: 卡片设定描述。
        tags: 卡片标签。
        visual_instructions: 用户或 Agent 补充的视觉要求。

    Returns:
        可直接传给 OpenAI Images API 的中文提示词。

    Raises:
        ValueError: 分类不支持或名称为空。
    """
    if category not in CARD_IMAGE_CATEGORIES:
        raise ValueError("仅支持为角色或地点卡片生图")
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("请先填写卡片名称再生图")

    clean_description = description.strip()[:4000]
    clean_tags = "、".join(str(tag).strip() for tag in (tags or []) if str(tag).strip())
    clean_visual = visual_instructions.strip()[:2000]

    if category == "characters":
        composition = (
            "生成一张竖向全身角色立绘：画面只有一个清晰主体，完整展示头部、服装和脚部，"
            "轮廓适合叠加在视觉小说背景上；使用精致半写实游戏概念美术风格，背景透明或干净纯色。"
        )
    else:
        composition = (
            "生成一张横向环境背景图：以地点空间、建筑或自然环境为主体，采用宽阔景别，"
            "重要内容放在画面中央安全区域以便后续裁成 16:9；使用精致半写实游戏概念美术风格，"
            "不要出现抢占画面的角色特写。"
        )

    facts = [f"名称：{clean_name}"]
    if clean_description:
        facts.append(f"设定：{clean_description}")
    if clean_tags:
        facts.append(f"标签：{clean_tags}")
    if clean_visual:
        facts.append(f"额外视觉要求：{clean_visual}")
    facts.append("不得添加标题、字幕、边框、水印、Logo 或任何可读文字。")
    return composition + "\n" + "\n".join(facts)


def _extract_png_bytes(response: Any) -> bytes:
    """从 OpenAI Images 响应中提取并校验 PNG 字节。"""
    items = getattr(response, "data", None)
    first = items[0] if isinstance(items, list) and items else None
    encoded = getattr(first, "b64_json", None) if first is not None else None
    if not isinstance(encoded, str) or not encoded:
        raise CardImageGenerationError("生图服务未返回图片数据")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CardImageGenerationError("生图服务返回了无效的 Base64 图片数据") from exc
    if not data:
        raise CardImageGenerationError("生图服务返回了空图片")
    if not data.startswith(_PNG_SIGNATURE):
        raise CardImageGenerationError("生图服务返回的内容不是 PNG 图片")
    return data


def generate_card_image_asset(
    store: ProjectStore,
    project_id: str,
    *,
    category: str,
    name: str,
    description: str = "",
    tags: list[str] | None = None,
    visual_instructions: str = "",
    image_client: Any | None = None,
) -> GeneratedCardImage:
    """调用生图模型并把结果保存为当前项目的唯一命名资产。

    Args:
        store: 项目存储。
        project_id: 目标项目 id。
        category: ``characters`` 或 ``locations``。
        name: 卡片名称。
        description: 卡片设定描述。
        tags: 卡片标签。
        visual_instructions: 用户或 Agent 补充的视觉要求。
        image_client: 可选的 OpenAI 兼容客户端；测试时注入，生产环境按 ``IMAGE_*`` 构建。

    Returns:
        已落盘资产的文件名、相对路径及本次模型参数。

    Raises:
        CardImageConfigurationError: 缺少生图配置。
        CardImageGenerationError: 模型调用、响应解析或资产落盘失败。
        ValueError: 卡片分类或名称不合法。
    """
    prompt, model, size, background, request_params = _prepare_image_request(
        category,
        name=name,
        description=description,
        tags=tags,
        visual_instructions=visual_instructions,
    )
    try:
        client = image_client or config.build_image_client()
    except RuntimeError as exc:
        raise CardImageConfigurationError(str(exc)) from exc
    try:
        response = client.images.generate(**request_params)
    except CardImageGenerationError:
        raise
    except Exception as exc:
        raise CardImageGenerationError("生图服务调用失败，请稍后重试") from exc
    return _persist_generated_image(
        store,
        project_id,
        response,
        prompt=prompt,
        model=model,
        size=size,
        background=background,
    )


async def agenerate_card_image_asset(
    store: ProjectStore,
    project_id: str,
    *,
    category: str,
    name: str,
    description: str = "",
    tags: list[str] | None = None,
    visual_instructions: str = "",
    image_client: Any | None = None,
    cancel_event: asyncio.Event | Any | None = None,
) -> GeneratedCardImage:
    """异步生图；``cancel_event`` 置位后取消未完成的 HTTP，不落盘。

    Args:
        store: 项目存储。
        project_id: 目标项目 id。
        category: ``characters`` 或 ``locations``。
        name: 卡片名称。
        description: 卡片设定描述。
        tags: 卡片标签。
        visual_instructions: 用户或 Agent 补充的视觉要求。
        image_client: 可选客户端；缺省时构建异步 OpenAI 客户端。
        cancel_event: 停止标志，支持 ``threading.Event`` 或 ``asyncio.Event``。

    Returns:
        已落盘资产。

    Raises:
        CardImageCancelled: 落盘前请求被取消。
        CardImageConfigurationError: 缺少生图配置。
        CardImageGenerationError: 模型调用、响应解析或资产落盘失败。
        ValueError: 卡片分类或名称不合法。
    """
    if _event_is_set(cancel_event):
        raise CardImageCancelled("生图请求已取消")
    prompt, model, size, background, request_params = _prepare_image_request(
        category,
        name=name,
        description=description,
        tags=tags,
        visual_instructions=visual_instructions,
    )
    owned_client = image_client is None
    try:
        client = image_client or config.build_async_image_client()
    except RuntimeError as exc:
        raise CardImageConfigurationError(str(exc)) from exc
    try:
        try:
            pending = client.images.generate(**request_params)
            response = await _await_image_response(pending, cancel_event)
        except CardImageCancelled:
            raise
        except Exception as exc:
            raise CardImageGenerationError("生图服务调用失败，请稍后重试") from exc
        if _event_is_set(cancel_event):
            raise CardImageCancelled("生图请求已取消")
        return _persist_generated_image(
            store,
            project_id,
            response,
            prompt=prompt,
            model=model,
            size=size,
            background=background,
        )
    finally:
        if owned_client:
            await _aclose_client(client)


def _prepare_image_request(
    category: str,
    *,
    name: str,
    description: str = "",
    tags: list[str] | None = None,
    visual_instructions: str = "",
) -> tuple[str, str, str, str | None, dict[str, Any]]:
    """校验配置并构造 Images API 请求参数。"""
    prompt = build_card_image_prompt(
        category,
        name=name,
        description=description,
        tags=tags,
        visual_instructions=visual_instructions,
    )
    params = config.get_card_image_params(category)
    model = str(params["model"])
    size = str(params["size"])
    background = params["background"]
    if background not in (None, "transparent", "opaque", "auto"):
        raise CardImageGenerationError(
            "背景配置只能是 transparent、opaque 或 auto"
        )
    if background == "transparent" and model.startswith("gpt-image-2"):
        raise CardImageGenerationError(
            "gpt-image-2 不支持透明背景；角色请改用支持透明背景的模型或取消 transparent 配置"
        )
    request_params: dict[str, Any] = {
        "prompt": prompt,
        "model": model,
        "n": 1,
        "size": size,
        "output_format": "png",
    }
    if background is not None:
        request_params["background"] = background
    return prompt, model, size, background, request_params


def _persist_generated_image(
    store: ProjectStore,
    project_id: str,
    response: Any,
    *,
    prompt: str,
    model: str,
    size: str,
    background: str | None,
) -> GeneratedCardImage:
    """把模型返回的 PNG 写入项目资产库。"""
    data = _extract_png_bytes(response)
    try:
        filename = store.add_asset(project_id, "generated.png", data)
    except ValueError as exc:
        raise CardImageGenerationError(str(exc)) from exc
    return GeneratedCardImage(
        name=filename,
        path=f"assets/{filename}",
        prompt=prompt,
        model=model,
        size=size,
        background=background,
    )


def _event_is_set(cancel_event: Any | None) -> bool:
    """读取 threading/asyncio Event 是否已置位。"""
    if cancel_event is None:
        return False
    checker = getattr(cancel_event, "is_set", None)
    return bool(checker()) if callable(checker) else False


async def _await_image_response(pending: Any, cancel_event: Any | None) -> Any:
    """等待生图 HTTP；取消标志置位后取消未完成的请求。"""
    if not inspect.isawaitable(pending):
        if _event_is_set(cancel_event):
            raise CardImageCancelled("生图请求已取消")
        return pending
    task = asyncio.ensure_future(pending)
    try:
        while not task.done():
            if _event_is_set(cancel_event):
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                raise CardImageCancelled("生图请求已取消")
            await asyncio.wait({task}, timeout=0.05)
        return task.result()
    except CardImageCancelled:
        raise
    except asyncio.CancelledError:
        if _event_is_set(cancel_event):
            raise CardImageCancelled("生图请求已取消") from None
        raise


async def _aclose_client(client: Any) -> None:
    """关闭异步客户端；同步替身没有 close 时忽略。"""
    close = getattr(client, "close", None)
    if not callable(close):
        return
    result = close()
    if inspect.isawaitable(result):
        await result
