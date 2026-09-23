"""Agent 执行轨迹的序列化、路径映射和信封字段。

把 LangChain 工具输入/输出变成可经 SSE 传输的 JSON，隐藏密钥类字段，并把虚拟路径
映射到创作者能理解的内容类型。不生成额外的思路摘要。
"""

from __future__ import annotations

import json
import re
import time
from typing import Any
from uuid import uuid4

# 单字段或整段 JSON 的最大字符数，避免把整份素材复制进 SSE。
TRACE_PAYLOAD_MAX_CHARS = 8000
# 视为敏感、必须打码的键名片段。
_SECRET_KEY_PARTS = ("api_key", "apikey", "authorization", "secret", "token", "password")
# 虚拟项目路径 → 自然内容类型。
_PROJECT_FILE_TYPES = {
    "/project/intent.md": "intent",
    "/project/outline.md": "outline",
    "/project/world.json": "world",
    "/project/events.json": "events",
    "/project/meta.json": "meta",
}
_SCENE_PATH = re.compile(r"^/project/scenes/([^/]+)\.json$")
_FRAGMENT_LABELS = {
    "intent": "创作意图",
    "outline": "故事大纲",
    "world": "世界设定",
    "events": "事件图",
    "meta": "项目信息",
}


def new_event_id() -> str:
    """生成可经 JSON 传输的事件 id。"""
    return uuid4().hex


def now_timestamp() -> float:
    """当前 UNIX 时间戳，供过程事件排序。"""
    return time.time()


def serialize_trace_payload(value: Any, *, limit: int = TRACE_PAYLOAD_MAX_CHARS) -> Any:
    """把工具输入或输出转成 JSON 安全结构，超长则截断，敏感键打码。

    Args:
        value: 原始工具参数或返回值。
        limit: 序列化后允许保留的最大字符数。

    Returns:
        可 JSON 序列化的结构；无法表示时退回字符串摘要。
    """
    sanitized = _sanitize(value)
    try:
        encoded = json.dumps(sanitized, ensure_ascii=False, default=str)
    except TypeError:
        encoded = str(sanitized)
    if len(encoded) <= limit:
        return sanitized
    return {
        "_truncated": True,
        "preview": encoded[:limit],
        "original_chars": len(encoded),
    }


def _sanitize(value: Any) -> Any:
    """递归去掉密钥类字段，并把非常规对象转成字符串。"""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return f"<bytes {len(value)}>"
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            name = str(key)
            if any(part in name.lower() for part in _SECRET_KEY_PARTS):
                cleaned[name] = "***"
            else:
                cleaned[name] = _sanitize(item)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    content = getattr(value, "content", None)
    if content is not None and not isinstance(value, type):
        return _sanitize(content)
    return str(value)


def extract_tool_path(tool_input: Any) -> str | None:
    """从文件类工具输入中取出虚拟路径。"""
    if isinstance(tool_input, dict):
        path = tool_input.get("path") or tool_input.get("file_path")
        if isinstance(path, str) and path.strip():
            return path.strip()
    if isinstance(tool_input, str) and tool_input.startswith("/project/"):
        return tool_input
    return None


def path_to_preview_target(path: str | None) -> dict[str, str] | None:
    """把项目虚拟路径映射成预览刷新目标。

    Args:
        path: 如 ``/project/world.json`` 或 ``/project/scenes/ev-1.json``。

    Returns:
        ``{"data_type": ..., "event_id": ...}``；无法识别时返回 ``None``。
    """
    if not path:
        return None
    normalized = path.strip()
    if normalized in _PROJECT_FILE_TYPES:
        data_type = _PROJECT_FILE_TYPES[normalized]
        if data_type == "meta":
            return None
        return {"data_type": data_type}
    match = _SCENE_PATH.match(normalized)
    if match:
        return {"data_type": "scenes", "event_id": match.group(1)}
    return None


def fragment_label(data_type: str) -> str:
    """把片段键转成面向创作者的自然名称。"""
    if data_type.startswith("scene:"):
        return f"情节 {data_type.split(':', 1)[1]}"
    if data_type == "scenes":
        return "情节"
    return _FRAGMENT_LABELS.get(data_type, data_type)


def duration_ms(started_at: float | None, ended_at: float | None = None) -> int | None:
    """由开始时间计算耗时毫秒；缺少开始时间时返回 ``None``。"""
    if started_at is None:
        return None
    finish = ended_at if ended_at is not None else time.time()
    return max(0, int((finish - started_at) * 1000))
