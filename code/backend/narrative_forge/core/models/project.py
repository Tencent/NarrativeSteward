"""项目元数据模型。

一个"项目"对应 ``<workspace>/projects/<id>/`` 目录；本模块定义记录在
``meta.json`` 中的元信息，包括各数据片段（world/outline/...）的版本号 revision
与阶段状态，用于支撑并发控制（§6.4）与前端进度展示。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pydantic import BaseModel, Field


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 字符串（统一时间格式）。"""
    return datetime.now(timezone.utc).isoformat()


class ProjectMeta(BaseModel):
    """项目元数据。

    Attributes:
        id: 项目唯一标识（目录名）。
        name: 项目展示名称。
        created_at: 创建时间（ISO 字符串）。
        updated_at: 最近更新时间（ISO 字符串）。
        revisions: 各数据片段的版本号，键为 data_type（如 "intent"/"world"/"outline"），
            值为单调递增整数；用于乐观并发与前端"是否需要刷新"的判定。
        stages: 各阶段状态，键为 data_type，值如 "empty"/"ready"/"error"。
        based_on: 旧版上游 revision 基线，仅用于兼容已有 ``meta.json``；当前产品逻辑不再
            更新、读取或展示由它派生的“内容过时”状态。
        scene_revisions: 场景层（阶段 4）**按事件**独立的版本号，键为事件 id、值为该事件
            情节图的 revision（见 DESIGN §4.2(g)）。场景图分文件 ``scenes/<event_id>.json``，
            每个事件的情节可单独生成/重写，故版本各自维护，不并入 :attr:`revisions`。
        scene_based_on: 旧版场景上游 revision 基线，仅用于已有项目反序列化兼容。
    """

    id: str
    name: str
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    revisions: dict[str, int] = Field(default_factory=dict)
    stages: dict[str, str] = Field(default_factory=dict)
    based_on: dict[str, dict[str, int]] = Field(default_factory=dict)
    scene_revisions: dict[str, int] = Field(default_factory=dict)
    scene_based_on: dict[str, dict[str, int]] = Field(default_factory=dict)
