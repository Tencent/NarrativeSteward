"""Agent 回合修改集的捕获、确定性差异、持久化和整轮撤销。"""

from __future__ import annotations

import difflib
import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from narrative_forge.core.models.agent_changeset import (
    AgentChangeset,
    ChangeDetail,
    ChangeLocation,
    ChangedFragment,
)
from narrative_forge.core.models.project import _now_iso
from narrative_forge.core.store import ProjectStore
from narrative_forge.core.store.store import DATA_TYPES, TEXT_TYPES, atomic_write_text

_COLLECTION_TYPES = {
    "worldview": "worldview",
    "characters": "character",
    "locations": "location",
    "factions": "faction",
    "history": "history",
    "other": "other",
    "state_variables": "state_variable",
    "nodes": "event",
    "beats": "beat",
}

# 顶层容器：从空文件写出时应继续拆成卡片/事件，而不是整包一条。
_CONTAINER_OBJECT_TYPES = frozenset({"world", "events"})

_BASELINE_META_KEY = "__meta__"
_BASELINE_VALIDATION_KEY = "__validation__"


class AgentChangesetConflict(RuntimeError):
    """changeset 已解决或项目 revision 已变化，不能安全整轮撤销。"""


class AgentChangesetService:
    """管理项目级 Agent changeset。

    Args:
        store: 项目事实来源存储。
    """

    def __init__(self, store: ProjectStore):
        self.store = store

    def _changeset_dir(self, project_id: str, *, create: bool = False) -> Path:
        """返回项目 changeset 目录。

        Args:
            project_id: 项目 id。
            create: 仅写入路径才允许建目录；读取不得改动包内资源。
        """
        directory = self.store.project_path(project_id) / "agent_changesets"
        if create:
            self.store.assert_writable(project_id)
            directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _changeset_path(
        self,
        project_id: str,
        changeset_id: str,
        *,
        create: bool = False,
    ) -> Path:
        """返回指定 changeset 文件路径并阻断目录穿越。"""
        safe_id = Path(changeset_id).name
        if not safe_id or safe_id != changeset_id:
            raise ValueError("非法 changeset id")
        return self._changeset_dir(project_id, create=create) / f"{safe_id}.json"

    def _write(self, changeset: AgentChangeset) -> None:
        """原子保存 changeset。"""
        self.store.assert_writable(changeset.project_id)
        atomic_write_text(
            self._changeset_path(changeset.project_id, changeset.id, create=True),
            json.dumps(changeset.model_dump(), ensure_ascii=False, indent=2),
        )

    def load(self, project_id: str, changeset_id: str) -> AgentChangeset:
        """读取并校验指定 changeset。

        Raises:
            FileNotFoundError: changeset 不存在。
        """
        path = self._changeset_path(project_id, changeset_id)
        if not path.exists():
            raise FileNotFoundError(path)
        return AgentChangeset.model_validate_json(path.read_text("utf-8"))

    def latest(self, project_id: str) -> AgentChangeset | None:
        """返回项目最近创建的 changeset；不存在时返回 ``None``。"""
        directory = self._changeset_dir(project_id)
        if not directory.exists():
            return None
        items = [
            AgentChangeset.model_validate_json(path.read_text("utf-8"))
            for path in directory.glob("*.json")
        ]
        return max(items, key=lambda item: item.created_at) if items else None

    def latest_pending(self, project_id: str) -> AgentChangeset | None:
        """返回项目最近待检查的 changeset。"""
        directory = self._changeset_dir(project_id)
        if not directory.exists():
            return None
        pending = [
            item
            for path in directory.glob("*.json")
            if (
                item := AgentChangeset.model_validate_json(
                    path.read_text("utf-8")
                )
            ).status
            == "pending"
        ]
        return max(pending, key=lambda item: item.created_at) if pending else None

    def capture_baseline(self, project_id: str) -> dict[str, dict[str, Any]]:
        """捕获回合开始前全部可由 Agent 修改的结构化内容和 revision。

        Args:
            project_id: 目标项目 id。

        Returns:
            以 ``intent``、``events``、``scene:<event_id>`` 等键索引的内存基线。
        """
        meta = self.store.load_meta(project_id)
        snapshot: dict[str, dict[str, Any]] = {}
        for data_type in TEXT_TYPES:
            path = self.store.text_file(project_id, data_type)
            snapshot[data_type] = {
                "data_type": data_type,
                "event_id": None,
                "revision": meta.revisions.get(data_type, 0),
                "content": self.store.get_text(project_id, data_type)
                if path.exists()
                else None,
            }
        for data_type in DATA_TYPES:
            snapshot[data_type] = {
                "data_type": data_type,
                "event_id": None,
                "revision": meta.revisions.get(data_type, 0),
                "content": self.store.get_data(project_id, data_type),
            }
        scene_ids = {
            *self.store.list_scene_event_ids(project_id),
            *meta.scene_revisions.keys(),
        }
        for event_id in sorted(scene_ids):
            key = f"scene:{event_id}"
            snapshot[key] = {
                "data_type": "scene",
                "event_id": event_id,
                "revision": meta.scene_revisions.get(event_id, 0),
                "content": self.store.get_scene(project_id, event_id),
            }
        asset_dir = self.store.assets_dir(project_id)
        if asset_dir.exists():
            for path in sorted(asset_dir.iterdir()):
                if not path.is_file():
                    continue
                raw = path.read_bytes()
                snapshot[f"asset:{path.name}"] = {
                    "data_type": "asset",
                    "event_id": path.name,
                    "revision": 0,
                    "content": {
                        "filename": path.name,
                        "sha256": hashlib.sha256(raw).hexdigest(),
                    },
                    "bytes": raw,
                }
        snapshot[_BASELINE_META_KEY] = {
            "data_type": "__meta__",
            "event_id": None,
            "revision": 0,
            "content": {
                "revisions": dict(meta.revisions),
                "stages": dict(meta.stages),
                "scene_revisions": dict(meta.scene_revisions),
                "updated_at": meta.updated_at,
            },
        }
        validation_path = self.store.validation_file(project_id)
        snapshot[_BASELINE_VALIDATION_KEY] = {
            "data_type": "__validation__",
            "event_id": None,
            "revision": 0,
            "content": (
                validation_path.read_text("utf-8") if validation_path.exists() else None
            ),
        }
        return snapshot

    def resolve_pending_implicitly(self, project_id: str) -> AgentChangeset | None:
        """把最近待检查 changeset 登记为隐式保留。"""
        pending = self.latest_pending(project_id)
        if pending is None:
            return None
        return self.keep(project_id, pending.id, implicit=True)

    def complete(
        self,
        project_id: str,
        turn_id: str,
        baseline: dict[str, dict[str, Any]],
    ) -> AgentChangeset | None:
        """比较回合前后内容；有实际修改时形成持久 changeset。"""
        current = self.capture_baseline(project_id)
        fragments: list[ChangedFragment] = []
        for key in self._fragment_keys(baseline, current):
            before_item = baseline.get(key) or {
                "data_type": "scene",
                "event_id": key.split(":", 1)[1],
                "revision": 0,
                "content": None,
            }
            after_item = current.get(key) or {
                **before_item,
                "content": None,
            }
            before = before_item.get("content")
            after = after_item.get("content")
            if before == after:
                continue
            data_type = str(after_item.get("data_type") or before_item["data_type"])
            event_id = after_item.get("event_id") or before_item.get("event_id")
            details = self._diff_fragment(data_type, event_id, before, after)
            if not details:
                continue
            fragments.append(
                ChangedFragment(
                    key=key,
                    data_type=data_type,
                    event_id=event_id,
                    input_revision=int(before_item.get("revision", 0)),
                    output_revision=int(after_item.get("revision", 0)),
                    before=before,
                    after=after,
                    details=details,
                )
            )
        if not fragments:
            return None
        counts: dict[str, int] = {"total": 0}
        for fragment in fragments:
            counts[fragment.data_type] = counts.get(fragment.data_type, 0) + len(
                fragment.details
            )
            for detail in fragment.details:
                counts[detail.operation] = counts.get(detail.operation, 0) + 1
                counts["total"] += 1
        changeset = AgentChangeset(
            id=f"changeset-{uuid.uuid4().hex[:12]}",
            project_id=project_id,
            turn_id=turn_id,
            fragments=fragments,
            counts=counts,
        )
        self._write(changeset)
        return changeset

    def restore_to_baseline(
        self,
        project_id: str,
        baseline: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        """把项目内容和版本恢复到回合开始前的基线，丢弃本轮全部写入。

        用于 Agent 回合中途失败：不生成 changeset，也不递增 revision。
        对话记录不在恢复范围内，由调用方继续写入失败提示。

        Args:
            project_id: 目标项目 id。
            baseline: :meth:`capture_baseline` 在回合开始时返回的快照。

        Returns:
            ``restored_keys`` 为实际改回的片段键；``restored_validation`` 表示检测记录是否改回。
        """
        current = self.capture_baseline(project_id)
        restored_keys: list[str] = []
        for key in self._fragment_keys(baseline, current):
            before_item = baseline.get(key) or {}
            after_item = current.get(key) or {}
            if before_item.get("content") == after_item.get("content"):
                continue
            self._restore_fragment(project_id, key, before_item, after_item)
            restored_keys.append(key)

        meta_before = (baseline.get(_BASELINE_META_KEY) or {}).get("content") or {}
        self.store.restore_version_fields(
            project_id,
            revisions=dict(meta_before.get("revisions") or {}),
            stages=dict(meta_before.get("stages") or {}),
            scene_revisions=dict(meta_before.get("scene_revisions") or {}),
            updated_at=meta_before.get("updated_at"),
        )

        validation_before = (baseline.get(_BASELINE_VALIDATION_KEY) or {}).get("content")
        validation_after = (current.get(_BASELINE_VALIDATION_KEY) or {}).get("content")
        restored_validation = validation_before != validation_after
        if restored_validation:
            self.store.replace_validation_record_text(project_id, validation_before)

        return {
            "restored_keys": restored_keys,
            "restored_validation": restored_validation,
            "changed": bool(restored_keys or restored_validation),
        }

    def restore_keys(
        self,
        project_id: str,
        baseline: dict[str, dict[str, Any]],
        keys: list[str],
    ) -> list[str]:
        """只把指定片段恢复到回合前内容，保留其它已合法登记的 revision。

        用于预算主动收口：非法片段不能留在磁盘上冒充当前版本。
        """
        current = self.capture_baseline(project_id)
        restored: list[str] = []
        meta_before = (baseline.get(_BASELINE_META_KEY) or {}).get("content") or {}
        revisions = dict(self.store.load_meta(project_id).revisions)
        scene_revisions = dict(self.store.load_meta(project_id).scene_revisions)
        stages = dict(self.store.load_meta(project_id).stages)
        for key in keys:
            before_item = baseline.get(key) or {}
            after_item = current.get(key) or {}
            if before_item.get("content") == after_item.get("content") and key in current:
                # 内容相同也要把错误 stage 清掉。
                data_type = str(before_item.get("data_type") or after_item.get("data_type") or "")
                if data_type and data_type not in {"scene", "asset"}:
                    stages[data_type] = (meta_before.get("stages") or {}).get(data_type, "empty")
                continue
            self._restore_fragment(project_id, key, before_item, after_item)
            restored.append(key)
            if key.startswith("scene:"):
                event_id = key.split(":", 1)[1]
                scene_revisions[event_id] = (meta_before.get("scene_revisions") or {}).get(event_id, 0)
            elif key in (meta_before.get("revisions") or {}):
                revisions[key] = (meta_before.get("revisions") or {}).get(key, 0)
                stages[key] = (meta_before.get("stages") or {}).get(key, "empty")
        self.store.restore_version_fields(
            project_id,
            revisions=revisions,
            stages=stages,
            scene_revisions=scene_revisions,
            updated_at=self.store.load_meta(project_id).updated_at,
        )
        return restored

    def _restore_fragment(
        self,
        project_id: str,
        key: str,
        before_item: dict[str, Any],
        after_item: dict[str, Any],
    ) -> None:
        """把单个文本、JSON、情节或配图片段恢复为基线内容或删除。"""
        data_type = str(
            before_item.get("data_type")
            or after_item.get("data_type")
            or "scene"
        )
        event_id = before_item.get("event_id") or after_item.get("event_id")
        before = before_item.get("content")
        if data_type == "asset":
            filename = str(event_id or "")
            if before is None:
                self.store.delete_asset(project_id, filename)
                return
            raw = before_item.get("bytes")
            if not isinstance(raw, (bytes, bytearray)):
                raise AgentChangesetConflict(
                    f"失败回合无法恢复配图 {filename}：基线未保存原始字节"
                )
            self.store.write_asset_bytes(project_id, filename, bytes(raw))
            return
        if data_type == "scene":
            scene_id = str(event_id or key.split(":", 1)[-1])
            if before is None:
                self.store.delete_scene(project_id, scene_id)
            else:
                self.store.set_scene(project_id, scene_id, before)
            return
        if data_type in TEXT_TYPES:
            if before is None:
                self.store.delete_text(project_id, data_type)
            else:
                self.store.set_text(project_id, data_type, str(before))
            return
        if before is None:
            self.store.delete_data(project_id, data_type)
        else:
            self.store.set_data(project_id, data_type, before)

    @staticmethod
    def _fragment_keys(*snapshots: dict[str, dict[str, Any]]) -> list[str]:
        """返回可恢复的内容片段键，排除 meta / 检测记录等内部快照。"""
        keys: set[str] = set()
        for snapshot in snapshots:
            keys.update(snapshot)
        return sorted(key for key in keys if not key.startswith("__"))

    def keep(
        self,
        project_id: str,
        changeset_id: str,
        *,
        implicit: bool = False,
    ) -> AgentChangeset:
        """明确或隐式保留一轮修改；重复相同操作保持幂等。"""
        changeset = self.load(project_id, changeset_id)
        desired = "implicit_keep" if implicit else "explicit_keep"
        if changeset.status == "kept" and changeset.resolution == desired:
            return changeset
        if changeset.status != "pending":
            raise AgentChangesetConflict(f"修改集当前不能保留: {changeset.status}")
        changeset.status = "kept"
        changeset.resolution = desired
        changeset.resolved_at = _now_iso()
        self._write(changeset)
        return changeset

    def revert(self, project_id: str, changeset_id: str) -> AgentChangeset:
        """在 revision 未变化时恢复整轮回合前内容，并产生更高 revision。"""
        changeset = self.load(project_id, changeset_id)
        if changeset.status == "reverted":
            return changeset
        if changeset.status != "pending":
            raise AgentChangesetConflict(f"修改集当前不能撤销: {changeset.status}")
        self._verify_revert_baseline(project_id, changeset)
        reverted_revisions: dict[str, int] = {}
        for fragment in changeset.fragments:
            if fragment.data_type == "asset":
                filename = fragment.event_id or ""
                self.store.delete_asset(project_id, filename)
                revision = 0
            elif fragment.data_type == "scene":
                event_id = fragment.event_id or ""
                if fragment.before is None:
                    self.store.delete_scene(project_id, event_id)
                else:
                    self.store.set_scene(project_id, event_id, fragment.before)
                revision = self.store.bump_scene_revision(project_id, event_id)
            elif fragment.data_type in TEXT_TYPES:
                if fragment.before is None:
                    self.store.delete_text(project_id, fragment.data_type)
                else:
                    self.store.set_text(
                        project_id,
                        fragment.data_type,
                        str(fragment.before),
                    )
                revision = self.store.bump_revision(project_id, fragment.data_type)
            else:
                if fragment.before is None:
                    self.store.delete_data(project_id, fragment.data_type)
                else:
                    self.store.set_data(
                        project_id,
                        fragment.data_type,
                        fragment.before,
                    )
                revision = self.store.bump_revision(project_id, fragment.data_type)
            reverted_revisions[fragment.key] = revision
        changeset.status = "reverted"
        changeset.resolution = "reverted"
        changeset.resolved_at = _now_iso()
        changeset.reverted_revisions = reverted_revisions
        self._write(changeset)
        return changeset

    def _verify_revert_baseline(
        self,
        project_id: str,
        changeset: AgentChangeset,
    ) -> None:
        """确认项目仍等于回合结束状态，防止覆盖后续修改。"""
        current = self.capture_baseline(project_id)
        conflicts: list[str] = []
        for fragment in changeset.fragments:
            if fragment.data_type == "asset" and fragment.before is not None:
                conflicts.append(f"{fragment.key}(不支持恢复删除或覆盖)")
                continue
            item = current.get(fragment.key)
            current_revision = int(item.get("revision", 0)) if item else 0
            current_content = item.get("content") if item else None
            if (
                current_revision != fragment.output_revision
                or current_content != fragment.after
            ):
                conflicts.append(fragment.key)
        if conflicts:
            raise AgentChangesetConflict(
                f"本轮之后已有其它修改，不能整轮撤销: {', '.join(conflicts)}"
            )

    def _diff_fragment(
        self,
        data_type: str,
        event_id: str | None,
        before: Any,
        after: Any,
    ) -> list[ChangeDetail]:
        """按文本行或稳定 id 结构生成确定性差异。"""
        if data_type in TEXT_TYPES:
            return self._diff_text(data_type, before, after)
        if data_type == "asset":
            filename = event_id or ""
            operation = (
                "add" if before is None else "remove" if after is None else "modify"
            )
            return [
                ChangeDetail(
                    path=f"assets[{filename}]",
                    data_type="asset",
                    object_type="asset",
                    object_id=filename,
                    operation=operation,
                    before=before,
                    after=after,
                    location=ChangeLocation(
                        board="world",
                        object_type="asset",
                        object_id=filename,
                    ),
                )
            ]
        details: list[ChangeDetail] = []
        self._diff_value(
            before,
            after,
            path=data_type,
            data_type=data_type,
            event_id=event_id,
            object_type=data_type,
            object_id=event_id,
            field=None,
            details=details,
        )
        return details

    def _diff_text(self, data_type: str, before: Any, after: Any) -> list[ChangeDetail]:
        """使用行级 SequenceMatcher 生成文本差异块。"""
        before_lines = str(before or "").splitlines()
        after_lines = str(after or "").splitlines()
        matcher = difflib.SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
        details: list[ChangeDetail] = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            operation = (
                "add" if tag == "insert" else "remove" if tag == "delete" else "modify"
            )
            details.append(
                ChangeDetail(
                    path=f"{data_type}.lines[{i1 + 1}:{i2}]",
                    data_type=data_type,
                    object_type="text",
                    field="lines",
                    operation=operation,
                    before="\n".join(before_lines[i1:i2]) or None,
                    after="\n".join(after_lines[j1:j2]) or None,
                    location=ChangeLocation(board=data_type),
                )
            )
        return details

    def _diff_value(
        self,
        before: Any,
        after: Any,
        *,
        path: str,
        data_type: str,
        event_id: str | None,
        object_type: str,
        object_id: str | None,
        field: str | None,
        details: list[ChangeDetail],
    ) -> None:
        """递归比较 JSON 值；带稳定 id 的列表按对象和字段展开。"""
        if before == after or (self._is_absent(before) and self._is_absent(after)):
            return
        before, after = self._expand_missing_container(
            before,
            after,
            object_type=object_type,
            field=field,
        )
        if isinstance(before, dict) and isinstance(after, dict):
            for key in sorted(set(before) | set(after)):
                self._diff_value(
                    before.get(key),
                    after.get(key),
                    path=f"{path}.{key}",
                    data_type=data_type,
                    event_id=event_id,
                    object_type=object_type,
                    object_id=object_id,
                    field=key,
                    details=details,
                )
            return
        if self._is_id_collection(before) or self._is_id_collection(after):
            before_by_id = self._by_id(before)
            after_by_id = self._by_id(after)
            collection = path.rsplit(".", 1)[-1]
            child_type = self._collection_object_type(data_type, collection)
            for child_id in sorted(set(before_by_id) | set(after_by_id)):
                self._diff_value(
                    before_by_id.get(child_id),
                    after_by_id.get(child_id),
                    path=f"{path}[{child_id}]",
                    data_type=data_type,
                    event_id=event_id,
                    object_type=child_type,
                    object_id=child_id,
                    field=None,
                    details=details,
                )
            return
        operation = "add" if before is None else "remove" if after is None else "modify"
        details.append(
            ChangeDetail(
                path=path,
                data_type=data_type,
                object_type=object_type,
                object_id=object_id,
                field=field,
                operation=operation,
                before=before,
                after=after,
                location=self._location(
                    data_type,
                    event_id,
                    object_type,
                    object_id,
                ),
            )
            )

    @staticmethod
    def _is_absent(value: Any) -> bool:
        """空文件、空对象和空列表视为同一侧没有内容，避免拆出无意义的空集合新增。"""
        return value is None or value == [] or value == {}

    @staticmethod
    def _expand_missing_container(
        before: Any,
        after: Any,
        *,
        object_type: str,
        field: str | None,
    ) -> tuple[Any, Any]:
        """整份设定/事件图从空文件写出时，把缺失的一侧当成空对象再往里拆。

        单张卡、单个事件仍保持一条（不拆名称/描述）。整段情节文件不是容器类型，
        新增或删除继续保持一条，只打开所属事件的情节页。
        """
        if field is not None or object_type not in _CONTAINER_OBJECT_TYPES:
            return before, after
        if before is None and isinstance(after, dict):
            return {}, after
        if after is None and isinstance(before, dict):
            return before, {}
        return before, after

    @staticmethod
    def _is_id_collection(value: Any) -> bool:
        """判断值是否为全部带稳定非空 id 的对象列表。"""
        return isinstance(value, list) and bool(value) and all(
            isinstance(item, dict) and item.get("id") for item in value
        )

    @staticmethod
    def _by_id(value: Any) -> dict[str, dict[str, Any]]:
        """把带稳定 id 的对象列表转换为索引；其它值视为空集合。"""
        if not isinstance(value, list):
            return {}
        return {
            str(item["id"]): item
            for item in value
            if isinstance(item, dict) and item.get("id")
        }

    @staticmethod
    def _collection_object_type(data_type: str, collection: str) -> str:
        """根据数据类型和集合字段返回用户可理解的对象类型。"""
        if collection == "edges":
            return "scene_edge" if data_type == "scene" else "event_edge"
        return _COLLECTION_TYPES.get(collection, collection.rstrip("s") or "object")

    @staticmethod
    def _location(
        data_type: str,
        event_id: str | None,
        object_type: str,
        object_id: str | None,
    ) -> ChangeLocation:
        """把差异对象映射为前端可执行的面板定位描述。"""
        if data_type in {"intent", "outline", "world"}:
            return ChangeLocation(
                board=data_type,
                object_type=object_type,
                object_id=object_id,
            )
        if data_type == "scene":
            return ChangeLocation(
                board="events",
                subtab="content",
                event_id=event_id,
                object_type=object_type,
                object_id=object_id,
            )
        subtab = "variables" if object_type == "state_variable" else "network"
        return ChangeLocation(
            board="events",
            subtab=subtab,
            event_id=object_id if object_type == "event" else None,
            object_type=object_type,
            object_id=object_id,
        )
