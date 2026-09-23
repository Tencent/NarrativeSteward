"""情节 speaker 的世界卡片硬引用解析与反向占用检查。

``speaker`` 仍是字符串，但其唯一合法非空值是六类设定卡片中全局唯一的卡片 id。
``dialogue`` / ``monologue`` 必须引用已有卡片；未知、歧义或自由名称阻止保存。
见 DESIGN §4.5 / §5.8。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from narrative_forge.core.models.scene_graph import SceneGraph
from narrative_forge.core.models.world import WORLD_CARD_CATEGORY_KEYS

UNKNOWN_SPEAKER_LABEL = "未识别发言者"
SPEAKER_PORTRAIT_CATEGORY = "characters"


@dataclass(frozen=True)
class WorldCardRef:
    """一张可用于 speaker 解析的设定卡片引用身份。"""

    card_id: str
    name: str
    category: str


@dataclass(frozen=True)
class SpeakerResolution:
    """一次 speaker 解析结果。"""

    raw: str
    display_name: str
    category: str | None = None
    card_id: str | None = None
    resolved: bool = False
    is_character_speaker: bool = False
    unknown: bool = False
    ambiguous: bool = False


@dataclass(frozen=True)
class WorldCardIndex:
    """六类设定卡片按 id 分组的索引。"""

    by_id: dict[str, tuple[WorldCardRef, ...]]


def build_world_card_index(world_data: dict[str, Any] | None) -> WorldCardIndex:
    """从 world.json 内容建立六类卡片索引。

    Args:
        world_data: 世界设定原始字典；缺失时视为空设定。

    Returns:
        按卡片 id 分组的索引；跨分类重复项保留全部匹配。
    """
    by_id: dict[str, list[WorldCardRef]] = {}
    source = world_data if isinstance(world_data, dict) else {}
    for category in WORLD_CARD_CATEGORY_KEYS:
        cards = source.get(category) or []
        if not isinstance(cards, list):
            continue
        for card in cards:
            if not isinstance(card, dict):
                continue
            ref = WorldCardRef(
                card_id=str(card.get("id") or ""),
                name=str(card.get("name") or ""),
                category=category,
            )
            if ref.card_id:
                by_id.setdefault(ref.card_id, []).append(ref)
    return WorldCardIndex(
        by_id={key: tuple(value) for key, value in by_id.items()},
    )


def unique_world_card_ids(index: WorldCardIndex) -> set[str]:
    """返回当前设定中全局唯一的卡片 id。"""
    return {card_id for card_id, matches in index.by_id.items() if len(matches) == 1}


def ambiguous_world_card_ids(index: WorldCardIndex) -> set[str]:
    """返回同时出现在多个分类中的卡片 id。"""
    return {card_id for card_id, matches in index.by_id.items() if len(matches) > 1}


def resolve_speaker_reference(
    raw: str | None,
    index: WorldCardIndex,
) -> SpeakerResolution:
    """按精确卡片 id 解析 speaker，用于界面显示名和立绘资格。

    Args:
        raw: 原始 speaker 字符串。
        index: :func:`build_world_card_index` 的结果。

    Returns:
        显示名、分类、是否已唯一解析、是否角色及是否未知/歧义。
    """
    speaker = str(raw or "").strip()
    if not speaker:
        return SpeakerResolution(raw="", display_name="")
    id_matches = index.by_id.get(speaker, ())
    if len(id_matches) == 1:
        card = id_matches[0]
        return SpeakerResolution(
            raw=speaker,
            display_name=card.name or speaker,
            category=card.category,
            card_id=card.card_id,
            resolved=True,
            is_character_speaker=card.category == SPEAKER_PORTRAIT_CATEGORY,
        )
    if len(id_matches) > 1:
        return SpeakerResolution(
            raw=speaker,
            display_name=UNKNOWN_SPEAKER_LABEL,
            card_id=speaker,
            ambiguous=True,
        )
    return SpeakerResolution(
        raw=speaker,
        display_name=UNKNOWN_SPEAKER_LABEL,
        unknown=True,
    )


def world_card_identity_digest(world_data: dict[str, Any] | None) -> str | None:
    """计算世界设定「分类 + 卡片 id」身份摘要。

    不纳入名称、描述或配图。``world_data is None`` 表示文件缺失。

    Args:
        world_data: 已解析的 world.json；缺失时返回 ``None``。

    Returns:
        SHA-256 十六进制摘要，或 ``None``。
    """
    if world_data is None:
        return None
    lines: list[str] = []
    source = world_data if isinstance(world_data, dict) else {}
    for category in WORLD_CARD_CATEGORY_KEYS:
        cards = source.get(category) or []
        if not isinstance(cards, list):
            continue
        ids = sorted(
            {
                str(card.get("id"))
                for card in cards
                if isinstance(card, dict) and card.get("id")
            }
        )
        lines.extend(f"{category}:{card_id}" for card_id in ids)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def collect_world_card_usages(
    scenes: list[SceneGraph] | list[dict[str, Any]],
) -> dict[str, list[dict[str, str]]]:
    """收集情节对世界卡片的反向引用。

    Args:
        scenes: 已解析或原始情节图列表。

    Returns:
        ``card_id → [{event_id, beat_id, field}]``；``field`` 为 ``speaker`` 或 ``location``。
    """
    usages: dict[str, list[dict[str, str]]] = {}
    for scene in scenes:
        if isinstance(scene, SceneGraph):
            event_id = scene.event_id
            beats = [
                (beat.id, beat.speaker, beat.location)
                for beat in scene.beats
            ]
        elif isinstance(scene, dict):
            event_id = str(scene.get("event_id") or "")
            raw_beats = scene.get("beats") or []
            beats = []
            if isinstance(raw_beats, list):
                for beat in raw_beats:
                    if not isinstance(beat, dict):
                        continue
                    beats.append(
                        (
                            str(beat.get("id") or ""),
                            str(beat.get("speaker") or ""),
                            str(beat.get("location") or ""),
                        )
                    )
        else:
            continue
        for beat_id, speaker, location in beats:
            speaker_id = str(speaker or "").strip()
            location_id = str(location or "").strip()
            if speaker_id:
                usages.setdefault(speaker_id, []).append(
                    {
                        "event_id": event_id,
                        "beat_id": beat_id,
                        "field": "speaker",
                    }
                )
            if location_id:
                usages.setdefault(location_id, []).append(
                    {
                        "event_id": event_id,
                        "beat_id": beat_id,
                        "field": "location",
                    }
                )
    return usages


def collect_duplicate_world_card_id_errors(
    world_data: dict[str, Any] | None,
) -> list[str]:
    """检查六类设定中是否存在重复卡片 id。

    Args:
        world_data: 拟保存的世界设定。

    Returns:
        稳定排序的错误说明；为空表示每个 id 全局唯一。
    """
    index = build_world_card_index(world_data)
    errors: list[str] = []
    for card_id, matches in sorted(index.by_id.items()):
        if len(matches) > 1:
            categories = "、".join(sorted({card.category for card in matches}))
            errors.append(
                f"设定卡片 id「{card_id}」同时出现在分类 {categories}，无法唯一确定"
            )
    return errors


def collect_world_card_reference_errors(
    world_data: dict[str, Any] | None,
    scenes: list[SceneGraph] | list[dict[str, Any]],
) -> list[str]:
    """检查世界设定是否仍覆盖情节中的 speaker / location 硬引用。

    Args:
        world_data: 拟保存的世界设定。
        scenes: 当前全部情节图。

    Returns:
        稳定排序的错误说明；为空表示引用仍有效。
    """
    index = build_world_card_index(world_data)
    unique_ids = unique_world_card_ids(index)
    location_ids = {
        card.card_id
        for matches in index.by_id.values()
        for card in matches
        if card.category == "locations" and len(matches) == 1
    }
    errors = collect_duplicate_world_card_id_errors(world_data)
    usages = collect_world_card_usages(scenes)
    for card_id, refs in sorted(usages.items()):
        matches = index.by_id.get(card_id, ())
        for ref in refs:
            event_id = ref["event_id"]
            beat_id = ref["beat_id"]
            field = ref["field"]
            if field == "location":
                if card_id not in location_ids:
                    if len(matches) > 1:
                        errors.append(
                            f"事件 {event_id} 的情节节点 {beat_id} 的地点「{card_id}」"
                            "同时出现在多个设定分类，无法唯一确定"
                        )
                    else:
                        errors.append(
                            f"事件 {event_id} 的情节节点 {beat_id} 仍引用地点「{card_id}」，"
                            "但当前世界设定的地点分类中没有这张卡片"
                        )
                continue
            if card_id not in unique_ids:
                if len(matches) > 1:
                    categories = "、".join(sorted({card.category for card in matches}))
                    errors.append(
                        f"事件 {event_id} 的情节节点 {beat_id} 的发言人「{card_id}」"
                        f"同时出现在设定分类 {categories}，无法唯一确定"
                    )
                else:
                    errors.append(
                        f"事件 {event_id} 的情节节点 {beat_id} 仍引用发言人「{card_id}」，"
                        "但当前世界设定中没有这张卡片"
                    )
    errors.sort()
    return errors
