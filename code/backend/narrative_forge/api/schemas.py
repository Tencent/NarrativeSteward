"""API 请求/响应模型（Pydantic）。

只放与 HTTP 边界相关的轻量 DTO；领域模型（ProjectMeta/WorldSetting）仍以核心层为准。
"""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class CreateProjectReq(BaseModel):
    """新建项目请求。"""

    name: str = Field(..., min_length=1, description="项目展示名称")


class MaterialUploadReq(BaseModel):
    """上传一份素材请求（纯文本；后缀须为 .md/.txt/.json）。"""

    filename: str = Field(..., min_length=1, description="素材文件名（仅取 basename）")
    content: str = Field(..., description="素材纯文本内容")


class AssetUploadReq(BaseModel):
    """上传一张配图请求（角色/地点卡片，见 DESIGN §5.8）。

    图片以 base64 传输（复用无 multipart 依赖的 JSON 上传范式）；后端解码后落盘。

    Attributes:
        filename: 原始文件名（仅用于取后缀判类型；须为 png/jpg/jpeg/webp/gif）。
        data_b64: 图片二进制的 base64 编码（可为纯 base64 或 ``data:`` URL，后端两者都容错）。
    """

    filename: str = Field(..., min_length=1, description="原始文件名（取后缀判类型）")
    data_b64: str = Field(..., min_length=1, description="图片内容的 base64（或 data: URL）")


class AssetGenerateReq(BaseModel):
    """从角色/地点卡片草稿生成一张项目配图。

    面板路径只生成资产并返回相对路径，卡片 ``image`` 仍由前端写入 world 草稿后统一保存。
    """

    category: Literal["characters", "locations"] = Field(..., description="卡片分类")
    name: str = Field(..., min_length=1, description="卡片名称")
    description: str = Field(default="", description="卡片设定描述")
    tags: list[str] = Field(default_factory=list, description="卡片标签")
    visual_instructions: str = Field(default="", description="可选的额外视觉要求")


class DataPutReq(BaseModel):
    """手动保存某片段请求（world/outline 为 JSON 对象，intent 为字符串）。

    Attributes:
        content: 片段内容；JSON 片段传对象，自由文本片段传字符串。
        base_revision: 客户端编辑所基于的 revision；与服务端当前 revision 不一致则判冲突
            （HTTP 409）。首次写入可传 ``0`` 或 ``None``。
    """

    content: Any = Field(..., description="片段内容（JSON 对象或字符串）")
    base_revision: int | None = Field(default=None, description="乐观锁基线 revision")


class PlaytestRouteEdgeReq(BaseModel):
    """试玩情景中一条实际经过的图边。"""

    kind: Literal["scene", "event"] = Field(..., description="边所在层")
    edge_id: str = Field(..., min_length=1, max_length=128, description="稳定边 id")


class PlaytestCurrentReq(BaseModel):
    """试玩情景中的当前位置。"""

    event_id: str = Field(default="", max_length=128)
    beat_id: str = Field(default="", max_length=128)
    location_id: str = Field(default="", max_length=128)
    speaker_id: str = Field(default="", max_length=128)


class PlaytestContextReq(BaseModel):
    """发送瞬间的试玩情景；只含稳定 id、路线和状态。"""

    schema_version: int = Field(default=1, ge=1, le=1)
    status: str = Field(default="playing", max_length=32)
    phase: str = Field(default="scene", max_length=32)
    revisions: dict[str, int] = Field(default_factory=dict)
    scene_revisions: dict[str, int] = Field(default_factory=dict)
    current: PlaytestCurrentReq = Field(default_factory=PlaytestCurrentReq)
    vars: dict[str, Any] = Field(default_factory=dict)
    taken_edges: list[PlaytestRouteEdgeReq] = Field(default_factory=list, max_length=64)
    focus_edge_id: str | None = Field(default=None, max_length=128)


class ChatReq(BaseModel):
    """触发一个 Agent 对话回合的请求。"""

    message: str = Field(..., min_length=1, description="用户输入")
    locale: str = Field(
        default="zh-CN",
        description="界面语言，用于构建对应语言的 prompt",
    )
    playtest_context: PlaytestContextReq | None = Field(
        default=None,
        description="可选的发送瞬间试玩情景；只服务当前回合，不写入聊天历史",
    )
