"""跨事件与情节收集状态变量的写入和读取位置。"""

from __future__ import annotations

from narrative_forge.core.store import ProjectStore


def _edge_id(edge: dict) -> str:
    """返回边的稳定 id；历史无 id 数据退化为起终点组合。"""
    return str(
        edge.get("id")
        or f"{edge.get('source', '')}->{edge.get('target', '')}"
    )


def _content_excerpt(content: object, limit: int = 36) -> str:
    """把情节正文压缩成单行定位摘要。"""
    text = " ".join(str(content or "").split())
    return text if len(text) <= limit else f"{text[:limit]}…"


def collect_state_variable_usages(
    events: dict | None,
    scenes: dict[str, dict] | None,
) -> list[dict]:
    """按变量声明顺序收集所有 effect 写入和 condition 读取。

    Args:
        events: 当前 ``events.json`` 内容。尚未创建事件图时为 ``None``。
        scenes: 事件 id 到当前 scene 内容的映射。无情节文件时为空 dict。

    Returns:
        每个已声明变量的名称、写入列表和读取列表。结果只含定位与条件摘要，
        不复制完整情节正文。空项目（无事件图）返回空列表。
    """
    events = events if isinstance(events, dict) else {}
    scenes = scenes if isinstance(scenes, dict) else {}
    event_nodes = events.get("nodes", [])
    event_titles = {
        str(node.get("id")): str(node.get("title") or node.get("id") or "")
        for node in event_nodes
        if node.get("id")
    }
    result = {
        str(variable.get("id")): {
            "variable_id": str(variable.get("id")),
            "variable_name": str(
                variable.get("name") or variable.get("id") or ""
            ),
            "writes": [],
            "reads": [],
        }
        for variable in events.get("state_variables", [])
        if variable.get("id")
    }

    for edge in events.get("edges", []):
        condition = edge.get("condition")
        variable_id = condition.get("var") if isinstance(condition, dict) else None
        if variable_id not in result:
            continue
        source_id = str(edge.get("source") or "")
        target_id = str(edge.get("target") or "")
        result[variable_id]["reads"].append(
            {
                "layer": "event",
                "object_kind": "edge",
                "object_id": _edge_id(edge),
                "event_id": source_id,
                "event_title": event_titles.get(source_id, source_id),
                "label": str(
                    edge.get("label")
                    or (
                        f"{event_titles.get(source_id, source_id)} → "
                        f"{event_titles.get(target_id, target_id)}"
                    )
                ),
                "operator": condition.get("op"),
                "value": condition.get("value"),
            }
        )

    for event_id, scene in scenes.items():
        event_title = event_titles.get(event_id, event_id)
        beats = scene.get("beats", [])
        beat_excerpts = {
            str(beat.get("id")): _content_excerpt(beat.get("content"))
            for beat in beats
            if beat.get("id")
        }
        for beat in beats:
            beat_id = str(beat.get("id") or "")
            for effect in beat.get("effects", []):
                variable_id = effect.get("var")
                if variable_id not in result:
                    continue
                result[variable_id]["writes"].append(
                    {
                        "layer": "scene",
                        "object_kind": "beat",
                        "object_id": beat_id,
                        "event_id": event_id,
                        "event_title": event_title,
                        "label": beat_excerpts.get(beat_id, beat_id),
                        "operator": effect.get("op"),
                        "value": effect.get("value"),
                    }
                )
        for edge in scene.get("edges", []):
            condition = edge.get("condition")
            variable_id = (
                condition.get("var") if isinstance(condition, dict) else None
            )
            if variable_id not in result:
                continue
            source_id = str(edge.get("source") or "")
            target_id = str(edge.get("target") or "")
            result[variable_id]["reads"].append(
                {
                    "layer": "scene",
                    "object_kind": "edge",
                    "object_id": _edge_id(edge),
                    "event_id": event_id,
                    "event_title": event_title,
                    "label": str(
                        edge.get("label")
                        or (
                            f"{beat_excerpts.get(source_id, source_id)} → "
                            f"{beat_excerpts.get(target_id, target_id)}"
                        )
                    ),
                    "operator": condition.get("op"),
                    "value": condition.get("value"),
                }
            )
    return list(result.values())


def state_variable_usages_for_project(
    store: ProjectStore,
    project_id: str,
) -> list[dict]:
    """读取当前项目快照并返回状态变量使用位置。

    Args:
        store: 项目存储。
        project_id: 已由 API 权限层确认可访问的项目 id。

    Returns:
        :func:`collect_state_variable_usages` 的结果。
    """
    # 新建项目尚无 events.json 时 get_data 返回 None，按空图处理。
    events = store.get_data(project_id, "events")
    scenes = {
        event_id: scene
        for event_id in store.list_scene_event_ids(project_id)
        if (scene := store.get_scene(project_id, event_id)) is not None
    }
    return collect_state_variable_usages(events, scenes)
