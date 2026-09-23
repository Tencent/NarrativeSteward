"""回合草稿工作区：隔离 Agent 写入与正式项目，并冻结不可变预览代次。

草稿目录位于工作区 ``.turn_workspaces/<project_id>/<turn_id>/``，不在 Agent 可见的
``/project`` 内。正式 REST、试玩和完整检测始终读取 canonical 项目。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from narrative_forge.core.store import DATA_TYPES, TEXT_TYPES, ProjectStore
from narrative_forge.core.store.store import atomic_write_text
from narrative_forge.orchestrator.turn_validation import (
    capture_fragment_map,
    diff_fragment_maps,
    preview_targets,
    validate_fragment_maps,
)

_CREATIVE_IGNORE = shutil.ignore_patterns(".*", "__pycache__")
_SAFE_ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_ASSET_PREFIX = "asset:"


@dataclass
class PreviewSnapshot:
    """一份不可变检查点预览。"""

    generation: int
    targets: list[dict[str, Any]]
    fragments: dict[str, Any]
    scenes: dict[str, Any]
    scene_overview: list[dict[str, Any]]
    assets: list[str] = field(default_factory=list)
    asset_dir: Path | None = None
    revoked: bool = False


@dataclass
class CommitResult:
    """草稿提交结果。"""

    updated: list[tuple[str, int]]
    deleted: list[str]
    targets: list[dict[str, Any]]
    validation_promoted: bool = False


@dataclass
class TurnWorkspace:
    """一个 Agent 回合的草稿、基线和预览代次。"""

    project_id: str
    turn_id: str
    canonical: ProjectStore
    draft_store: ProjectStore
    draft_dir: Path
    baseline: dict[str, str | None]
    checkpoint: dict[str, str | None]
    validation_baseline: str | None = None
    preview_generation: int = 0
    previews: dict[int, PreviewSnapshot] = field(default_factory=dict)
    phase: str = "running"
    last_checkpoint_step_id: str | None = None
    validation_promoted: bool = False
    service: Any = None


class TurnWorkspaceService:
    """进程内登记回合草稿；按项目+回合定位预览代次。"""

    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self._guard = threading.Lock()
        self._workspaces: dict[tuple[str, str], TurnWorkspace] = {}
        self._active_turn: dict[str, str] = {}

    def _root(self, project_id: str, turn_id: str) -> Path:
        """草稿根目录，位于项目目录之外。"""
        return self.store.workspace / ".turn_workspaces" / project_id / turn_id

    def begin(self, project_id: str, turn_id: str) -> TurnWorkspace:
        """复制正式项目为回合草稿，并捕获内容基线。"""
        source = self.store.project_path(project_id)
        destination = self._root(project_id, turn_id)
        if destination.exists():
            shutil.rmtree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, destination, ignore=_CREATIVE_IGNORE)
        draft_store = ProjectStore(self.store.workspace, project_root=destination)
        baseline = capture_fragment_map(self.store, project_id)
        validation_path = self.store.validation_file(project_id)
        validation_baseline = (
            validation_path.read_text("utf-8") if validation_path.exists() else None
        )
        workspace = TurnWorkspace(
            project_id=project_id,
            turn_id=turn_id,
            canonical=self.store,
            draft_store=draft_store,
            draft_dir=destination,
            baseline=baseline,
            checkpoint=dict(baseline),
            validation_baseline=validation_baseline,
            service=self,
        )
        with self._guard:
            self._workspaces[(project_id, turn_id)] = workspace
            self._active_turn[project_id] = turn_id
        return workspace

    def get(self, project_id: str, turn_id: str) -> TurnWorkspace | None:
        """返回已登记的回合工作区。"""
        with self._guard:
            return self._workspaces.get((project_id, turn_id))

    def active(self, project_id: str) -> TurnWorkspace | None:
        """返回该项目当前活动回合工作区。"""
        with self._guard:
            turn_id = self._active_turn.get(project_id)
            if not turn_id:
                return None
            return self._workspaces.get((project_id, turn_id))

    def publish_checkpoint(
        self,
        workspace: TurnWorkspace,
        *,
        step_id: str | None = None,
    ) -> PreviewSnapshot | None:
        """若自上次检查点以来有合法变化，冻结新的预览代次。

        Returns:
            新快照；无变化或验收失败时为 ``None``（失败时调用方读取 report）。
        """
        current = capture_fragment_map(workspace.draft_store, workspace.project_id)
        report = validate_fragment_maps(workspace.checkpoint, current)
        if not report.ok:
            return None
        if not report.changed_keys and not report.deleted_keys:
            return None
        workspace.preview_generation += 1
        snapshot = _freeze_preview(
            workspace,
            generation=workspace.preview_generation,
            current=current,
            changed_keys=report.changed_keys,
            deleted_keys=report.deleted_keys,
        )
        workspace.previews[snapshot.generation] = snapshot
        workspace.checkpoint = current
        workspace.last_checkpoint_step_id = step_id
        workspace.phase = "running"
        return snapshot

    def validate_current(self, workspace: TurnWorkspace):
        """对当前草稿相对回合基线做统一验收。"""
        current = capture_fragment_map(workspace.draft_store, workspace.project_id)
        return validate_fragment_maps(workspace.baseline, current)

    def get_preview(
        self,
        project_id: str,
        turn_id: str,
        generation: int,
    ) -> PreviewSnapshot | None:
        """读取不可变预览代次；已撤销或不存在时返回 ``None``。"""
        workspace = self.get(project_id, turn_id)
        if workspace is None:
            return None
        snapshot = workspace.previews.get(generation)
        if snapshot is None or snapshot.revoked:
            return None
        return snapshot

    def preview_asset_path(
        self,
        project_id: str,
        turn_id: str,
        generation: int,
        filename: str,
    ) -> Path | None:
        """返回某代冻结配图的真实路径；不存在或已撤销时返回 ``None``。"""
        snapshot = self.get_preview(project_id, turn_id, generation)
        if snapshot is None or snapshot.asset_dir is None:
            return None
        name = Path(filename or "").name
        if name not in snapshot.assets or not _SAFE_ASSET_NAME.fullmatch(name):
            return None
        path = (snapshot.asset_dir / name).resolve()
        try:
            path.relative_to(snapshot.asset_dir.resolve())
        except ValueError:
            return None
        return path if path.is_file() else None

    def revoke_previews(self, workspace: TurnWorkspace, reason: str = "aborted") -> list[int]:
        """作废该回合全部预览代次。"""
        del reason
        revoked: list[int] = []
        for generation, snapshot in workspace.previews.items():
            if not snapshot.revoked:
                snapshot.revoked = True
                revoked.append(generation)
        return revoked

    def commit(self, workspace: TurnWorkspace) -> CommitResult:
        """把草稿中的内容变化一次性写入正式项目并登记 revision。

        草稿检测报告仅在内容指纹与最终正式内容完全一致时晋升。任一步失败时正文、
        meta 与 validation 都恢复基线。
        """
        workspace.phase = "committing"
        workspace.validation_promoted = False
        current = capture_fragment_map(workspace.draft_store, workspace.project_id)
        report = validate_fragment_maps(workspace.baseline, current)
        if not report.ok:
            raise ValueError("草稿未通过基础验收，不能提交")
        updated: list[tuple[str, int]] = []
        try:
            _apply_content(workspace.canonical, workspace.project_id, workspace.baseline, current)
            updated = _bump_versions(
                workspace.canonical,
                workspace.project_id,
                report.changed_keys,
                report.deleted_keys,
            )
            workspace.validation_promoted = _promote_draft_validation(workspace)
        except Exception:
            from narrative_forge.orchestrator.turn_validation import restore_fragments

            restore_fragments(
                workspace.canonical,
                workspace.project_id,
                workspace.baseline,
            )
            workspace.canonical.replace_validation_record_text(
                workspace.project_id,
                workspace.validation_baseline,
            )
            workspace.phase = "aborted"
            workspace.validation_promoted = False
            raise
        workspace.phase = "committed"
        return CommitResult(
            updated=updated,
            deleted=report.deleted_keys,
            targets=preview_targets(report.changed_keys, report.deleted_keys),
            validation_promoted=workspace.validation_promoted,
        )

    def abort(self, workspace: TurnWorkspace) -> list[int]:
        """丢弃草稿并撤销预览；正式项目保持基线。"""
        revoked = self.revoke_previews(workspace, "aborted")
        workspace.phase = "aborted"
        if workspace.draft_dir.exists():
            shutil.rmtree(workspace.draft_dir, ignore_errors=True)
        with self._guard:
            self._workspaces.pop((workspace.project_id, workspace.turn_id), None)
            if self._active_turn.get(workspace.project_id) == workspace.turn_id:
                self._active_turn.pop(workspace.project_id, None)
        return revoked

    def finish(self, workspace: TurnWorkspace) -> None:
        """提交成功后清理草稿目录，预览保留到调用方撤销。"""
        if workspace.draft_dir.exists():
            shutil.rmtree(workspace.draft_dir, ignore_errors=True)

    def drop_turn(self, project_id: str, turn_id: str) -> None:
        """终态后移除工作区登记并删除残留目录。"""
        with self._guard:
            workspace = self._workspaces.pop((project_id, turn_id), None)
            if self._active_turn.get(project_id) == turn_id:
                self._active_turn.pop(project_id, None)
        if workspace is not None and workspace.draft_dir.exists():
            shutil.rmtree(workspace.draft_dir, ignore_errors=True)

    def cleanup_orphans(self) -> None:
        """删除没有活动回合的残留草稿目录。"""
        root = self.store.workspace / ".turn_workspaces"
        if not root.exists():
            return
        with self._guard:
            live = {(pid, tid) for pid, tid in self._workspaces}
        for project_dir in root.iterdir():
            if not project_dir.is_dir():
                continue
            for turn_dir in list(project_dir.iterdir()):
                if (project_dir.name, turn_dir.name) not in live:
                    shutil.rmtree(turn_dir, ignore_errors=True)


def _freeze_preview(
    workspace: TurnWorkspace,
    *,
    generation: int,
    current: dict[str, str | None],
    changed_keys: list[str],
    deleted_keys: list[str],
) -> PreviewSnapshot:
    """把当前合法草稿冻结为一份不可变 bundle。"""
    fragments: dict[str, Any] = {}
    scenes: dict[str, Any] = {}
    for key, raw in current.items():
        if raw is None:
            continue
        if key in TEXT_TYPES:
            fragments[key] = raw
        elif key in DATA_TYPES:
            try:
                fragments[key] = json.loads(raw)
            except json.JSONDecodeError:
                fragments[key] = raw
        elif key.startswith("scene:"):
            event_id = key.split(":", 1)[1]
            try:
                scenes[event_id] = json.loads(raw)
            except json.JSONDecodeError:
                scenes[event_id] = raw
    overview = _scene_overview(current)
    assets, asset_dir = _freeze_preview_assets(workspace, generation, current)
    return PreviewSnapshot(
        generation=generation,
        targets=preview_targets(changed_keys, deleted_keys),
        fragments=fragments,
        scenes=scenes,
        scene_overview=overview,
        assets=assets,
        asset_dir=asset_dir,
    )


def _scene_overview(current: dict[str, str | None]) -> list[dict[str, Any]]:
    """按事件 id 列出草稿中的情节是否存在。"""
    events_raw = current.get("events")
    event_ids: list[str] = []
    if events_raw:
        try:
            data = json.loads(events_raw)
            event_ids = [
                node["id"]
                for node in data.get("nodes", [])
                if isinstance(node, dict) and node.get("id")
            ]
        except json.JSONDecodeError:
            event_ids = []
    extra = [
        key.split(":", 1)[1]
        for key in current
        if key.startswith("scene:") and key.split(":", 1)[1] not in event_ids
    ]
    overview = []
    for event_id in [*event_ids, *extra]:
        raw = current.get(f"scene:{event_id}")
        overview.append(
            {
                "event_id": event_id,
                "has_scene": raw is not None,
            }
        )
    return overview


def _apply_content(
    store: ProjectStore,
    project_id: str,
    baseline: dict[str, str | None],
    current: dict[str, str | None],
) -> None:
    """把当前草稿正文应用到正式项目，不更新 revision。"""
    from narrative_forge.orchestrator.turn_validation import _write_fragment

    changed, _added, deleted = diff_fragment_maps(baseline, current)
    for key in deleted:
        _write_fragment(store, project_id, key, None)
    for key in changed:
        _write_fragment(store, project_id, key, current.get(key))


def _bump_versions(
    store: ProjectStore,
    project_id: str,
    changed_keys: list[str],
    deleted_keys: list[str],
) -> list[tuple[str, int]]:
    """一次性提升受影响片段的 revision，含已删除 scene 的墓碑。"""
    if not changed_keys and not deleted_keys:
        return []
    from narrative_forge.core.models.project import _now_iso

    meta = store.load_meta(project_id)
    updated: list[tuple[str, int]] = []
    for key in [*changed_keys, *deleted_keys]:
        if key.startswith("asset:"):
            continue
        if key.startswith("scene:"):
            event_id = key.split(":", 1)[1]
            meta.scene_revisions[event_id] = meta.scene_revisions.get(event_id, 0) + 1
            updated.append((key, meta.scene_revisions[event_id]))
            continue
        if key in TEXT_TYPES or key in DATA_TYPES:
            meta.revisions[key] = meta.revisions.get(key, 0) + 1
            if key in deleted_keys:
                meta.stages[key] = "empty"
            else:
                meta.stages[key] = "ready"
            updated.append((key, meta.revisions[key]))
    meta.updated_at = _now_iso()
    store._write_meta(meta)
    return updated


def snapshot_to_bundle(snapshot: PreviewSnapshot, *, turn_id: str) -> dict[str, Any]:
    """把预览快照编成 API JSON。配图只给标识，不把字节塞进 bundle。"""
    return {
        "turn_id": turn_id,
        "preview_generation": snapshot.generation,
        "targets": snapshot.targets,
        "fragments": snapshot.fragments,
        "scenes": snapshot.scenes,
        "scene_overview": snapshot.scene_overview,
        "preview_assets": {
            "turn_id": turn_id,
            "generation": snapshot.generation,
            "names": list(snapshot.assets),
        },
    }


def _preview_asset_dir(workspace: TurnWorkspace, generation: int) -> Path:
    """某一代冻结配图的目录。"""
    return workspace.draft_dir / ".previews" / str(generation) / "assets"


def _link_or_copy(source: Path, target: Path) -> None:
    """优先硬链接冻结 inode；文件系统不支持时回退复制。"""
    if target.exists() or target.is_symlink():
        target.unlink()
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _freeze_preview_assets(
    workspace: TurnWorkspace,
    generation: int,
    current: dict[str, str | None],
) -> tuple[list[str], Path]:
    """把该代草稿引用的配图冻结到不可变目录。"""
    dest = _preview_asset_dir(workspace, generation)
    dest.mkdir(parents=True, exist_ok=True)
    asset_dir = workspace.draft_store.assets_dir(workspace.project_id)
    names: list[str] = []
    for key in current:
        if not key.startswith(_ASSET_PREFIX):
            continue
        name = Path(key.split(":", 1)[1]).name
        if not name or not _SAFE_ASSET_NAME.fullmatch(name):
            continue
        source = asset_dir / name
        if not source.is_file():
            continue
        try:
            source.resolve().relative_to(asset_dir.resolve())
        except ValueError:
            continue
        _link_or_copy(source, dest / name)
        names.append(name)
    return names, dest


def _promote_draft_validation(workspace: TurnWorkspace) -> bool:
    """草稿检测指纹与最终正式内容一致时，把报告原子写入正式 latest.json。"""
    draft_path = workspace.draft_store.validation_file(workspace.project_id)
    if not draft_path.exists():
        return False
    try:
        record = json.loads(draft_path.read_text("utf-8"))
    except json.JSONDecodeError:
        return False
    if not isinstance(record, dict):
        return False
    fingerprint = record.get("fingerprint")
    digest = fingerprint.get("digest") if isinstance(fingerprint, dict) else None
    if not digest:
        return False
    current = workspace.canonical.validation_fingerprint(workspace.project_id)
    if current.get("digest") != digest:
        return False
    workspace.canonical.replace_validation_record_text(
        workspace.project_id,
        json.dumps(record, ensure_ascii=False, indent=2),
    )
    return True
