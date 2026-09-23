"""世界设定（World Setting）数据模型。

对应四阶段流水线的"世界设定"阶段产出（参考 story-forge 的 Extract）。本阶段不涉及
"图 + 状态变量"，结构为**按子类型分组的统一卡片**（见 DESIGN §3.2 设定层结构）：
世界观 / 角色 / 地点 / 势力 / 历史 / 其他，每组是一组同构 :class:`WorldCard`。

故事概要（synopsis）不再放这里——已归并到大纲层（``outline.md``，自由 Markdown）。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class WorldCard(BaseModel):
    """一张设定卡片（各子类型通用）。

    用 ``extra="forbid"`` 严格限定字段——只允许 ``id/name/description/tags/image`` 五个键，
    出现其它键（如自造的 ``summary``/``details``）会校验失败，触发回合末自纠，
    避免 Agent 自由发挥导致前端表单无法渲染。更丰富的信息应合并进 ``description``。

    Attributes:
        id: 稳定标识（如 ``"char-1"`` / ``"loc-2"``），供后续事件层引用该实体；可空。
        name: 卡片名称 / 标题（如角色名、概念名、地名）。
        description: 卡片描述正文（可含换行/分点的较长文本）。
        tags: 可选标签（如角色特质、地点属性）。
        image: 可选配图的**项目内相对路径**（如 ``"assets/<uuid>.png"``，见 DESIGN §5.8）。
            主要用于角色 / 地点卡片，供试玩体验层做背景图 / 角色立绘；缺省空串表示无配图。
            可由用户上传、面板生图或主 Agent 按明确请求生成，故不参与硬校验、留空即可。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = ""
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    image: str = ""


# 与前端 WorldForm / speaker 解析共用的六类设定键（见 DESIGN §4.5）。
WORLD_CARD_CATEGORY_KEYS = (
    "worldview",
    "characters",
    "locations",
    "factions",
    "history",
    "other",
)


class WorldSetting(BaseModel):
    """世界设定汇总：按子类型分组的卡片集合。

    用 ``extra="forbid"`` 严格限定顶层只能是下面 6 个**英文**子类型键——出现中文键名
    或其它键会校验失败，触发自纠，保证与前端分区表单（同样按这 6 个键）对齐。
    每个子类型都是一组 :class:`WorldCard`：

    Attributes:
        worldview: 世界观概念卡片（时代背景、规则体系、基调等，每条一张卡）。
        characters: 角色卡片。
        locations: 地点卡片。
        factions: 势力 / 组织卡片。
        history: 历史 / 背景事件卡片。
        other: 其它难以归类的设定卡片。
    """

    model_config = ConfigDict(extra="forbid")

    worldview: list[WorldCard] = Field(default_factory=list)
    characters: list[WorldCard] = Field(default_factory=list)
    locations: list[WorldCard] = Field(default_factory=list)
    factions: list[WorldCard] = Field(default_factory=list)
    history: list[WorldCard] = Field(default_factory=list)
    other: list[WorldCard] = Field(default_factory=list)
