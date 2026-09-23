"""全局配置与 LLM 后端构建。

集中处理：
- 读取 ``.env`` 与环境变量；
- 解析工作区路径（用户项目数据默认放在仓库根的 ``workspace/``，可配置）；
- 按配置构建 OpenAI 兼容的 LangChain ChatModel。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv  # 硬依赖（见 pyproject.toml），安装即必有

# config.py 位于 code/backend/narrative_forge/config.py：
# parents[0]=narrative_forge, [1]=backend, [2]=code, [3]=仓库根
_REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKEND_DIR = Path(__file__).resolve().parents[1]


def _load_env() -> None:
    """加载 ``.env`` 到环境变量。

    优先使用 ``NARRATIVE_FORGE_ENV_FILE`` 指定的文件，否则用 ``backend/.env``。
    """
    env_file = os.environ.get("NARRATIVE_FORGE_ENV_FILE", str(_BACKEND_DIR / ".env"))
    if Path(env_file).exists():
        load_dotenv(env_file)


_load_env()


def get_workspace() -> Path:
    """返回工作区根目录（不存在则创建）。

    可用环境变量 ``NARRATIVE_FORGE_WORKSPACE`` 覆盖，默认 ``<repo>/workspace``。
    """
    p = os.environ.get("NARRATIVE_FORGE_WORKSPACE")
    path = Path(p) if p else _REPO_ROOT / "workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _is_set(value: str | None) -> bool:
    """判断环境变量是否真正配置（排除占位符 ``your_xxx``）。"""
    return bool(value) and not value.startswith("your_")


def build_chat_model():
    """使用用户指定的密钥、接口地址和模型构建 OpenAI 兼容 ChatModel。

    Raises:
        RuntimeError: 缺少密钥、接口地址或模型名称。
    """
    settings = {
        name: os.environ.get(name, "").strip()
        for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL")
    }
    missing = [name for name, value in settings.items() if not _is_set(value)]
    if missing:
        raise RuntimeError(
            "未配置 LLM：请在 code/backend/.env 设置 "
            + "、".join(missing)
            + "（见 .env.example）"
        )

    timeout = float(os.environ.get("LLM_TIMEOUT", "180"))
    # 最大输出 token（生成长度）；输入/总长由模型上下文窗口决定，不在此设。
    max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "8192"))
    # 对瞬时错误（连接失败 / 5xx / 限流）自动重试的次数。上游网关偶发 "Backend error"
    # 时可减少对用户的打断（注意：流式已开始后的中途错误不一定能被此机制兜住）。
    max_retries = int(os.environ.get("LLM_MAX_RETRIES", "2"))

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=settings["OPENAI_MODEL"],
        api_key=settings["OPENAI_API_KEY"],
        base_url=settings["OPENAI_BASE_URL"],
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )


def build_image_client():
    """根据独立的 ``IMAGE_*`` 环境变量构建 OpenAI 兼容生图客户端。

    生图配置与对话 LLM 完全隔离，即使二者实际使用同一网关或 token，也必须分别配置，
    避免修改聊天模型时意外改变生图行为。

    Returns:
        配置好网关、密钥、超时和重试次数的 :class:`openai.OpenAI` 客户端。

    Raises:
        RuntimeError: 未配置有效的 ``IMAGE_API_KEY``。
    """
    return _build_openai_image_client(async_client=False)


def build_async_image_client():
    """构建可取消的异步生图客户端，供 Agent 回合停止时中断未落盘的出图请求。

    Returns:
        :class:`openai.AsyncOpenAI` 客户端。

    Raises:
        RuntimeError: 未配置有效的 ``IMAGE_API_KEY``。
    """
    return _build_openai_image_client(async_client=True)


def _build_openai_image_client(*, async_client: bool):
    """按 ``IMAGE_*`` 环境变量构建同步或异步 OpenAI 兼容生图客户端。"""
    image_key = os.environ.get("IMAGE_API_KEY")
    if not _is_set(image_key):
        raise RuntimeError("未配置生图模型：请在 backend/.env 设置 IMAGE_API_KEY")

    kwargs = {
        "api_key": image_key,
        "base_url": os.environ.get("IMAGE_BASE_URL") or None,
        "timeout": float(os.environ.get("IMAGE_TIMEOUT", "180")),
        "max_retries": int(os.environ.get("IMAGE_MAX_RETRIES", "2")),
    }
    if async_client:
        from openai import AsyncOpenAI

        return AsyncOpenAI(**kwargs)
    from openai import OpenAI

    return OpenAI(**kwargs)


def get_image_model() -> str:
    """返回生图模型名称；未配置时默认使用 ``gpt-image-2``。"""
    return os.environ.get("IMAGE_MODEL", "gpt-image-2")


def get_image_size() -> str:
    """返回角色/地点分类未单独配置时使用的通用生图尺寸。"""
    return os.environ.get("IMAGE_SIZE", "1024x1024")


def get_card_image_params(category: str) -> dict[str, str | None]:
    """返回角色或地点的生图参数，并回退到通用 ``IMAGE_*`` 配置。

    Args:
        category: ``characters`` 或 ``locations``。

    Returns:
        包含 ``model``、``size``、``background`` 的字典。分类背景未配置时返回 ``None``，
        让模型使用自身默认值。

    Raises:
        ValueError: 分类不支持。
    """
    prefixes = {
        "characters": "IMAGE_CHARACTER",
        "locations": "IMAGE_LOCATION",
    }
    prefix = prefixes.get(category)
    if prefix is None:
        raise ValueError("仅支持为角色或地点卡片生图")
    return {
        "model": os.environ.get(f"{prefix}_MODEL") or get_image_model(),
        "size": os.environ.get(f"{prefix}_SIZE") or get_image_size(),
        "background": os.environ.get(f"{prefix}_BACKGROUND") or None,
    }
