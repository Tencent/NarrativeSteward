"""Agent 单回合确定性修改摘要与整轮撤销模型。

changeset 保存完整回合前后基线，用于刷新后查看和冲突安全的整轮撤销。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from narrative_forge.core.models.project import _now_iso

ChangeOperation = Literal["add", "remove", "modify"]
ChangesetStatus = Literal["pending", "kept", "reverted"]


class ChangeLocation(BaseModel):
    """一项修改在结构化编辑界面中的定位信息。"""

    model_config = ConfigDict(extra="forbid")

    board: Literal["intent", "outline", "world", "events"]
    subtab: str | None = None
    event_id: str | None = None
    object_type: str | None = None
    object_id: str | None = None


class ChangeDetail(BaseModel):
    """一项由程序比较得到的字段级或文本块级修改。"""

    model_config = ConfigDict(extra="forbid")

    path: str
    data_type: str
    object_type: str
    object_id: str | None = None
    field: str | None = None
    operation: ChangeOperation
    before: Any = None
    after: Any = None
    location: ChangeLocation


class ChangedFragment(BaseModel):
    """一个被本轮 Agent 修改、可整体恢复的数据片段。"""

    model_config = ConfigDict(extra="forbid")

    key: str
    data_type: str
    event_id: str | None = None
    input_revision: int = Field(ge=0)
    output_revision: int = Field(ge=0)
    before: Any = None
    after: Any = None
    details: list[ChangeDetail] = Field(default_factory=list)


class AgentChangeset(BaseModel):
    """一次完整 Agent 回合产生的可检查、可整轮撤销修改集。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    project_id: str
    turn_id: str
    status: ChangesetStatus = "pending"
    created_at: str = Field(default_factory=_now_iso)
    resolved_at: str | None = None
    resolution: Literal["explicit_keep", "implicit_keep", "reverted"] | None = None
    fragments: list[ChangedFragment] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)
    reverted_revisions: dict[str, int] = Field(default_factory=dict)
