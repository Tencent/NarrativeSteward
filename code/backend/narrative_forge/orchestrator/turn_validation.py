"""回合草稿的内容级变更检测与基础验收。

用规范化正文比较基线与当前草稿，识别新增、修改和删除，而不是依赖文件 mtime。
验收覆盖 JSON/schema、引用、图结构和 scalar 跨文件契约；完整状态传播不在此运行。
"""

from __future__ import annotations

import json
from typing import Any

from narrative_forge.core.store import DATA_TYPES, TEXT_TYPES, ProjectStore
from narrative_forge.core.validation import TurnValidationReport, validate_project_draft

# 内容快照里资产键前缀。
_ASSET_PREFIX = "asset:"


def capture_fragment_map(store: ProjectStore, project_id: str) -> dict[str, str | None]:
    """读取当前项目全部创作片段的原始正文。

    Args:
        store: 项目存储（正式项目或回合草稿）。
        project_id: 项目 id。

    Returns:
        ``{key: 正文或 None}``。``None`` 表示文件不存在。scene 键为 ``scene:<event_id>``。
    """
    snapshot: dict[str, str | None] = {}
    for data_type in TEXT_TYPES:
        path = store.text_file(project_id, data_type)
        snapshot[data_type] = path.read_text("utf-8") if path.exists() else None
    for data_type in DATA_TYPES:
        path = store.data_file(project_id, data_type)
        snapshot[data_type] = path.read_text("utf-8") if path.exists() else None
    scene_ids = set(store.list_scene_event_ids(project_id))
    try:
        scene_ids.update(store.load_meta(project_id).scene_revisions.keys())
    except FileNotFoundError:
        pass
    for event_id in sorted(scene_ids):
        path = store.scene_file(project_id, event_id)
        snapshot[f"scene:{event_id}"] = path.read_text("utf-8") if path.exists() else None
    asset_dir = store.assets_dir(project_id)
    if asset_dir.exists():
        for path in sorted(asset_dir.iterdir()):
            if path.is_file():
                snapshot[f"{_ASSET_PREFIX}{path.name}"] = path.read_bytes().hex()
    return snapshot


def normalize_fragment(key: str, raw: str | None) -> str | None:
    """把片段正文规范成可比较摘要：合法 JSON 去空白排序，非法 JSON 保留原文。"""
    if raw is None:
        return None
    if key in DATA_TYPES or key.startswith("scene:"):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return f"INVALID_JSON\0{raw}"
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    if key.startswith(_ASSET_PREFIX):
        return raw
    return raw.replace("\r\n", "\n").replace("\r", "\n")


def diff_fragment_maps(
    baseline: dict[str, str | None],
    current: dict[str, str | None],
) -> tuple[list[str], list[str], list[str]]:
    """比较两份内容快照。

    Returns:
        ``(changed, added, deleted)`` 三个键列表。``changed`` 含新增和修改，不含纯删除。
    """
    keys = set(baseline) | set(current)
    changed: list[str] = []
    added: list[str] = []
    deleted: list[str] = []
    for key in sorted(keys):
        before = normalize_fragment(key, baseline.get(key))
        after = normalize_fragment(key, current.get(key))
        if before == after:
            continue
        if before is None and after is not None:
            added.append(key)
            changed.append(key)
        elif before is not None and after is None:
            deleted.append(key)
        else:
            changed.append(key)
    return changed, added, deleted


def dependency_closure(changed_keys: list[str], current: dict[str, str | None]) -> list[str]:
    """把直接变化扩展成必须重新验收的片段集合。

    - 改 ``world``：重检全部现存 scene 的地点引用；
    - 改 ``events``：重检全部现存 scene 的事件归属、变量引用和 scalar 契约；
    - 改任意 scene：该 scene 加上全部可解析 scene 与 events 的跨层契约。
    """
    keys = set(changed_keys)
    scene_keys = [key for key in current if key.startswith("scene:") and current.get(key) is not None]
    if "world" in keys or "events" in keys:
        keys.update(scene_keys)
    if any(key.startswith("scene:") for key in keys):
        if current.get("events") is not None:
            keys.add("events")
        keys.update(scene_keys)
    return sorted(keys)


def _parse_json(raw: str | None) -> tuple[dict | None, str | None]:
    """解析 JSON 正文；缺失返回 ``(None, None)``，非法返回 ``(None, 说明)``。"""
    if raw is None:
        return None, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, f"不是合法 JSON：{exc}"
    if not isinstance(data, dict):
        return None, "根节点必须是 JSON 对象"
    return data, None


def validate_fragment_maps(
    baseline: dict[str, str | None],
    current: dict[str, str | None],
) -> TurnValidationReport:
    """比较基线与当前草稿并执行依赖闭包基础验收。"""
    changed, _added, deleted = diff_fragment_maps(baseline, current)
    closure = dependency_closure(changed + deleted, current)
    check_world = "world" in closure
    check_events = "events" in closure
    check_scenes = any(key.startswith("scene:") for key in closure)
    world_data, world_err = _parse_json(current.get("world"))
    events_data, events_err = _parse_json(current.get("events"))
    scenes: dict[str, dict | None] = {}
    scene_raw_errors: dict[str, str] = {}
    scene_keys = {
        key for key in set(baseline) | set(current) if key.startswith("scene:")
    }
    for key in scene_keys:
        event_id = key.split(":", 1)[1]
        if key in deleted:
            scenes[event_id] = None
            continue
        data, err = _parse_json(current.get(key))
        if err:
            scene_raw_errors[event_id] = err
            scenes[event_id] = None
        else:
            scenes[event_id] = data
    issues = validate_project_draft(
        world_data=world_data if check_world or check_scenes else None,
        events_data=events_data if check_events or check_scenes else None,
        scenes=scenes if check_world or check_events or check_scenes else {},
        world_raw_error=world_err if check_world else None,
        events_raw_error=events_err if check_events else None,
        scene_raw_errors={
            event_id: msg
            for event_id, msg in scene_raw_errors.items()
            if f"scene:{event_id}" in closure
        },
        deleted_keys=deleted,
    )
    return TurnValidationReport(
        issues=issues,
        changed_keys=changed,
        deleted_keys=deleted,
    )


def restore_fragments(
    store: ProjectStore,
    project_id: str,
    baseline: dict[str, str | None],
    keys: list[str] | None = None,
) -> list[str]:
    """把指定片段写回基线正文；基线不存在则删除当前文件。

    Args:
        store: 目标存储。
        project_id: 项目 id。
        baseline: :func:`capture_fragment_map` 的回合前快照。
        keys: 要恢复的键；缺省恢复全部与当前不同的键。

    Returns:
        实际改回的键列表。
    """
    current = capture_fragment_map(store, project_id)
    targets = keys if keys is not None else list(set(baseline) | set(current))
    restored: list[str] = []
    for key in targets:
        before = baseline.get(key)
        after = current.get(key)
        if normalize_fragment(key, before) == normalize_fragment(key, after):
            continue
        _write_fragment(store, project_id, key, before)
        restored.append(key)
    return restored


def _write_fragment(
    store: ProjectStore,
    project_id: str,
    key: str,
    raw: str | None,
) -> None:
    """把一个片段写成给定正文，或在 ``raw is None`` 时删除。"""
    if key.startswith(_ASSET_PREFIX):
        filename = key.split(":", 1)[1]
        if raw is None:
            store.delete_asset(project_id, filename)
            return
        path = store.assets_dir(project_id)
        path.mkdir(parents=True, exist_ok=True)
        (path / filename).write_bytes(bytes.fromhex(raw))
        return
    if key.startswith("scene:"):
        event_id = key.split(":", 1)[1]
        if raw is None:
            store.delete_scene(project_id, event_id)
            return
        store.scene_file(project_id, event_id).parent.mkdir(parents=True, exist_ok=True)
        store._atomic_write_text(store.scene_file(project_id, event_id), raw)
        return
    if key in TEXT_TYPES:
        if raw is None:
            store.delete_text(project_id, key)
            return
        store.set_text(project_id, key, raw)
        return
    if key in DATA_TYPES:
        if raw is None:
            store.delete_data(project_id, key)
            return
        store._atomic_write_text(store.data_file(project_id, key), raw)


def preview_targets(changed_keys: list[str], deleted_keys: list[str]) -> list[dict[str, Any]]:
    """把变更键转成预览/正式刷新用的 target 列表。"""
    targets: list[dict[str, Any]] = []
    for key in changed_keys:
        if key.startswith(_ASSET_PREFIX):
            continue
        if key.startswith("scene:"):
            targets.append(
                {
                    "data_type": "scenes",
                    "event_id": key.split(":", 1)[1],
                    "deleted": False,
                }
            )
            continue
        targets.append({"data_type": key, "deleted": False})
    for key in deleted_keys:
        if key.startswith("scene:"):
            targets.append(
                {
                    "data_type": "scenes",
                    "event_id": key.split(":", 1)[1],
                    "deleted": True,
                }
            )
            continue
        if key in TEXT_TYPES or key in DATA_TYPES:
            targets.append({"data_type": key, "deleted": True})
    return targets
