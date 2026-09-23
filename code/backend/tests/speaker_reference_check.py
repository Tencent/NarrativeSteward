"""离线单测：情节 speaker 卡片 id 硬引用、保存拒绝与指纹身份。

覆盖 DESIGN §4.5 / §5.8：已知 ``oth-1`` 可保存；自由名称、未知 id、歧义 id
阻断 ``validate_scene`` 与完整检测预检；删除仍被引用的卡片会返回事件/beat 位置。
Agent 同一回合新增卡片并引用时，草稿校验读取本轮 world + scenes。

用法::

    PYTHONPATH=. python tests/speaker_reference_check.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from narrative_forge.core.models.state_validation import REPORT_SCHEMA_VERSION
from narrative_forge.core.speaker_references import (
    UNKNOWN_SPEAKER_LABEL,
    build_world_card_index,
    collect_world_card_reference_errors,
    resolve_speaker_reference,
    world_card_identity_digest,
)
from narrative_forge.core.store import ProjectStore
from narrative_forge.core.validation import (
    state_validation_report,
    validate_project_draft,
    validate_scene,
)

_STATE_VARS = [
    {"id": "flag", "name": "标记", "type": "flag", "initial": False},
]
_LOCATIONS = [{"id": "loc-1", "name": "旧钟楼"}]
_WORLD = {
    "worldview": [],
    "characters": [{"id": "char-1", "name": "林衡", "description": "向导", "tags": [], "image": ""}],
    "locations": [{"id": "loc-1", "name": "旧钟楼", "description": "", "tags": [], "image": ""}],
    "factions": [],
    "history": [],
    "other": [
        {
            "id": "oth-1",
            "name": "超级系统/王座试炼核心",
            "description": "试炼系统",
            "tags": [],
            "image": "",
        }
    ],
}


def _fail(message: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {message}")
    raise SystemExit(1)


def _assert(condition: bool, message: str) -> None:
    """断言条件成立。"""
    if not condition:
        _fail(message)
    print(f"   PASS  {message}")


def _events() -> dict:
    """最小可玩事件图：入口接到结局。"""
    return {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "end", "title": "结束", "type": "ending"},
        ],
        "edges": [{"id": "to-end", "source": "start", "target": "end"}],
    }


def _scene(event_id: str, speaker: str = "") -> dict:
    """单 beat 情节；有 speaker 时用对话，否则旁白。"""
    kind = "dialogue" if speaker else "narration"
    return {
        "event_id": event_id,
        "beats": [
            {
                "id": f"{event_id}-beat",
                "kind": kind,
                "speaker": speaker,
                "location": "loc-1",
                "content": "正文",
                "effects": [],
            }
        ],
        "edges": [],
    }


def _valid_scene_with_speaker(speaker: str) -> dict:
    """供 ``validate_scene`` 使用的带分支合法情节。"""
    return {
        "event_id": "ev-master",
        "beats": [
            {"id": "b-open", "kind": "narration", "location": "loc-1", "content": "走进静室。", "effects": []},
            {"id": "b-talk", "kind": "dialogue", "speaker": speaker, "location": "loc-1", "content": "系统提示。", "effects": []},
            {"id": "b-end", "kind": "narration", "location": "loc-1", "content": "结束。", "effects": []},
        ],
        "edges": [
            {"id": "s1", "source": "b-open", "target": "b-talk"},
            {"id": "s2", "source": "b-talk", "target": "b-end"},
        ],
    }


def _check_resolution() -> None:
    """核对只按卡片 id 解析，名称与自由文本不再回退。"""
    index = build_world_card_index(_WORLD)
    other = resolve_speaker_reference("oth-1", index)
    _assert(other.display_name == "超级系统/王座试炼核心", "oth-1 显示设定卡片名称")
    _assert(other.category == "other" and not other.is_character_speaker, "oth-1 无立绘资格")
    character = resolve_speaker_reference("char-1", index)
    _assert(character.is_character_speaker, "角色卡片有立绘资格")
    unique_name = resolve_speaker_reference("林衡", index)
    _assert(
        unique_name.unknown and unique_name.display_name == UNKNOWN_SPEAKER_LABEL,
        "卡片名称不再当作 speaker 解析",
    )
    free_name = resolve_speaker_reference("堂叔", index)
    _assert(
        free_name.unknown and free_name.display_name == UNKNOWN_SPEAKER_LABEL,
        "自由名称显示未识别发言者，不占立绘",
    )
    unknown = resolve_speaker_reference("oth-missing", index)
    _assert(
        unknown.unknown and unknown.display_name == UNKNOWN_SPEAKER_LABEL,
        "未知卡片 id 显示未识别发言者",
    )


def _check_hard_validation() -> None:
    """核对保存、草稿和完整检测都把非法 speaker 当硬错误。"""
    ok, message = validate_scene(
        _valid_scene_with_speaker("oth-1"),
        _STATE_VARS,
        _LOCATIONS,
        world_data=_WORLD,
    )
    _assert(ok, f"已知卡片 id 可以保存：{message}")

    ok, message = validate_scene(
        _valid_scene_with_speaker("超级系统"),
        _STATE_VARS,
        _LOCATIONS,
        world_data=_WORLD,
    )
    _assert(not ok and "超级系统" in message, f"自由名称不能保存：{message}")

    ok, message = validate_scene(
        _valid_scene_with_speaker("oth-missing"),
        _STATE_VARS,
        _LOCATIONS,
        world_data=_WORLD,
    )
    _assert(not ok and "oth-missing" in message, f"未知 id 不能保存：{message}")

    duplicate_world = {
        **_WORLD,
        "characters": [{"id": "oth-1", "name": "角色侧", "description": "", "tags": [], "image": ""}],
    }
    ok, message = validate_scene(
        _valid_scene_with_speaker("oth-1"),
        _STATE_VARS,
        _LOCATIONS,
        world_data=duplicate_world,
    )
    _assert(not ok and "无法唯一确定" in message, f"跨分类重复 id 不能保存：{message}")

    passed = state_validation_report(
        _events(),
        [_scene("start", "oth-1"), _scene("end")],
        world_data=_WORLD,
    )
    _assert(passed["status"] == "passed", "合法 speaker 完整检测可通过")
    _assert(passed["report_schema_version"] == REPORT_SCHEMA_VERSION, "正式报告 schema 版本")
    _assert(
        all(item.get("kind") != "speaker_unknown_card_id" for item in passed["warnings"]),
        "正式报告不再含 speaker 软警告",
    )

    failed = state_validation_report(
        _events(),
        [_scene("start", "堂叔"), _scene("end")],
        world_data=_WORLD,
    )
    _assert(failed["status"] == "failed", "自由名称使完整检测预检失败")
    _assert(
        any(item["kind"] == "scene_structure_invalid" for item in failed["issues"]),
        "非法 speaker 记为结构问题",
    )

    incomplete = state_validation_report(
        _events(),
        [_scene("start", "oth-1")],
        world_data=_WORLD,
    )
    _assert(incomplete["status"] == "incomplete", "缺情节时仍为 incomplete")


def _check_world_delete_and_same_turn() -> None:
    """删除被引用卡片失败；同一回合新增卡片并引用可通过草稿校验。"""
    usages = collect_world_card_reference_errors(
        {**_WORLD, "other": []},
        [_scene("start", "oth-1"), _scene("end")],
    )
    _assert(
        any("oth-1" in item and "start-beat" in item for item in usages),
        "删除仍被引用的卡片返回事件与 beat 位置",
    )

    issues = validate_project_draft(
        world_data={
            **_WORLD,
            "characters": [
                *_WORLD["characters"],
                {"id": "char-new", "name": "新角色", "description": "", "tags": [], "image": ""},
            ],
        },
        events_data=_events(),
        scenes={
            "start": _scene("start", "char-new"),
            "end": _scene("end"),
        },
    )
    _assert(issues == [], "同一回合新增卡片并引用可通过草稿校验")

    stale = validate_project_draft(
        world_data=_WORLD,
        events_data=_events(),
        scenes={
            "start": _scene("start", "char-new"),
            "end": _scene("end"),
        },
    )
    _assert(
        any("char-new" in item.message for item in stale),
        "引用尚未写入本轮 world 的卡片会被草稿校验拒绝",
    )


def _check_fingerprint() -> None:
    """名称/配图修改不改指纹；新增或跨分类移动卡片会改。"""
    workspace = Path(tempfile.mkdtemp(prefix="nf_speaker_fp_"))
    os.environ.setdefault("NARRATIVE_FORGE_WORKSPACE", str(workspace))
    store = ProjectStore(workspace)
    project = store.create_project("speaker-fp")
    store.set_data(project.id, "events", _events())
    store.set_data(project.id, "world", _WORLD)
    store.set_scene(project.id, "start", _scene("start", "oth-1"))
    store.set_scene(project.id, "end", _scene("end"))
    baseline = store.validation_fingerprint(project.id)
    snapshot = store.load_validation_snapshot(project.id)
    _assert(
        snapshot["fingerprint"]["digest"] == baseline["digest"],
        "快照指纹与独立计算一致",
    )
    _assert(snapshot["world"]["other"][0]["id"] == "oth-1", "快照包含 world 正文")
    _assert(baseline["parts"]["world_identity"] == world_card_identity_digest(_WORLD), "指纹纳入卡片身份")

    renamed = {
        **_WORLD,
        "other": [
            {
                **_WORLD["other"][0],
                "name": "改名后的系统",
                "description": "只改文案",
                "image": "assets/new.png",
            }
        ],
    }
    store.set_data(project.id, "world", renamed)
    after_text = store.validation_fingerprint(project.id)
    _assert(after_text["digest"] == baseline["digest"], "名称/描述/配图修改不改变检测指纹")

    moved = {
        **_WORLD,
        "other": [],
        "characters": [
            *_WORLD["characters"],
            {**_WORLD["other"][0]},
        ],
    }
    store.set_data(project.id, "world", moved)
    after_move = store.validation_fingerprint(project.id)
    _assert(after_move["digest"] != baseline["digest"], "跨分类移动卡片会改变身份指纹")

    added = {
        **_WORLD,
        "factions": [{"id": "fac-1", "name": "商会", "description": "", "tags": [], "image": ""}],
    }
    store.set_data(project.id, "world", added)
    after_add = store.validation_fingerprint(project.id)
    _assert(after_add["digest"] != baseline["digest"], "新增设定卡片会改变指纹")


def run_check() -> bool:
    """跑 speaker 硬引用解析、保存拒绝、草稿校验与指纹断言。"""
    _check_resolution()
    _check_hard_validation()
    _check_world_delete_and_same_turn()
    _check_fingerprint()
    return True


def main() -> int:
    """CLI 入口。"""
    print("── speaker 卡片 id 硬引用 / 保存拒绝 / 指纹断言 运行中 ...")
    run_check()
    print("\n==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
