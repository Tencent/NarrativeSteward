"""项目存储（真理之源）。

封装"一个项目 = 一个目录"的本地 JSON 读写，并维护每个数据片段的 revision。
按 §6.3/§9.3 的约定，所有对项目数据的写入都应经过本模块，禁止绕过直接改文件。

目录结构::

    <workspace>/projects/<project_id>/
        meta.json       # ProjectMeta
        materials/      # 用户上传的原始素材（多份纯文本：.md/.txt/.json）
        assets/         # 角色/地点卡片配图（二进制图片；见 DESIGN §5.8）
        intent.md       # 创作意图（自由文本）
        outline.md      # 故事大纲（自由 Markdown 文本）
        world.json      # 世界设定（分类卡片，JSON）
        events.json     # 事件图（状态变量 + 节点 + 边，JSON；见 DESIGN §4.2）
        scenes/         # 场景层（阶段 4）：每个事件一张情节图 scenes/<event_id>.json
        chat.jsonl      # 对话历史（面向展示的持久化 transcript）

注：并发全局锁与事件总线（§6.4/§6.5）属于 API 层职责（见 ``narrative_forge/api/runtime.py``）；
本模块只提供 revision 字段作为乐观并发的底层基础。
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path

from narrative_forge.core.models import ProjectMeta
from narrative_forge.core.quick_start_ids import (
    ReadOnlyProjectError,
    builtin_quick_start_project_dir,
    is_builtin_quick_start_id,
)
from narrative_forge.core.speaker_references import world_card_identity_digest

# 已支持的 JSON 数据片段类型（data_type）：走 Pydantic 校验。后续阶段（scenes）在此扩展。
DATA_TYPES = ("world", "events")

# 自由文本片段类型：**不走 JSON 校验**，仅做版本化（创作意图 intent + 弱格式大纲 outline）。
TEXT_TYPES = ("intent", "outline")

# 自由文本片段的文件名映射（data_type → 文件名）。
_TEXT_FILES = {"intent": "intent.md", "outline": "outline.md"}

# 素材库允许的纯文本后缀（其它格式暂不支持，见 DESIGN §6.9）。
MATERIAL_EXTS = (".md", ".txt", ".json")

# 配图（assets/）允许的图片后缀（见 DESIGN §5.8）。
ASSET_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
# 单张配图大小上限（字节）：~5MB，防止误传超大图占满磁盘。
ASSET_MAX_BYTES = 5 * 1024 * 1024

def _slugify(name: str) -> str:
    """把项目名转成适合做目录名的 slug（仅保留字母数字与连字符）。"""
    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", name.strip()).strip("-")
    return slug or "project"


def atomic_write_text(path: Path, content: str) -> None:
    """先完整写入同目录临时文件，再原子替换目标文本文件。

    Args:
        path: 目标文本文件。
        content: 使用 UTF-8 写入的完整内容。

    同目录临时文件保证 :meth:`Path.replace` 不跨文件系统；随机临时名避免
    并发写不同请求时互相覆盖。本函数只保证单文件不会暴露半写内容。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(content, "utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


class ProjectStore:
    """本地文件系统上的项目存储。

    Args:
        workspace: 工作区根目录；默认项目存放在其下的 ``projects/`` 子目录。
        project_root: 若提供，则该存储只指向这一份项目目录（回合草稿隔离副本）。
        projects_dir: 多项目根目录；缺省为 ``workspace/projects``。用户项目枚举
            只扫描该目录；内置教学样例按固定 id 解析到代码包资源。
    """

    @staticmethod
    def _atomic_write_text(path: Path, content: str) -> None:
        """兼容旧调用；新存储模块应复用模块级 :func:`atomic_write_text`。"""
        atomic_write_text(path, content)

    def __init__(
        self,
        workspace: Path,
        *,
        project_root: Path | None = None,
        projects_dir: Path | None = None,
    ):
        self.workspace = Path(workspace)
        self.projects_dir = Path(projects_dir) if projects_dir is not None else self.workspace / "projects"
        self._project_root = Path(project_root) if project_root else None
        self._system_project_lookup = None
        if self._project_root is None:
            self.projects_dir.mkdir(parents=True, exist_ok=True)

    def set_system_project_lookup(self, lookup) -> None:
        """兼容旧调用：内置教学样例已按固定 id 挂载，额外 lookup 只作后备。

        Args:
            lookup: ``project_id -> Path | None``。
        """
        self._system_project_lookup = lookup

    def assert_writable(self, project_id: str) -> None:
        """内置教学样例拒绝任何写入、删除或建目录。

        Args:
            project_id: 待检查的项目 id。

        Raises:
            ReadOnlyProjectError: id 属于代码包内的只读教学样例。
        """
        if is_builtin_quick_start_id(project_id):
            raise ReadOnlyProjectError("演示项目只读，请在自己的项目中修改")

    # ── 路径辅助 ────────────────────────────────────────────────────────────
    def _project_dir(self, project_id: str) -> Path:
        """返回某项目的目录路径。回合草稿可把根目录钉在隔离副本上。"""
        if self._project_root is not None:
            return self._project_root
        builtin_dir = builtin_quick_start_project_dir(project_id)
        if builtin_dir is not None:
            return builtin_dir
        if self._system_project_lookup is not None:
            system_dir = self._system_project_lookup(project_id)
            if system_dir is not None:
                return Path(system_dir)
        return self.projects_dir / project_id

    def project_path(self, project_id: str) -> Path:
        """返回某项目目录的绝对路径（供 Agent 文件后端 root_dir 使用）。"""
        return self._project_dir(project_id)

    def data_file(self, project_id: str, data_type: str) -> Path:
        """返回某 JSON 数据片段（world/events）对应的 JSON 文件路径。"""
        return self._project_dir(project_id) / f"{data_type}.json"

    def get_data(self, project_id: str, data_type: str) -> dict | None:
        """读取某 JSON 数据片段（world/events）；不存在或无法解析时返回 ``None``。"""
        f = self.data_file(project_id, data_type)
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text("utf-8"))
        except json.JSONDecodeError:
            return None

    def set_data(self, project_id: str, data_type: str, data: dict) -> None:
        """写入某 JSON 数据片段（world/events）到磁盘（不负责校验与版本登记）。"""
        self.assert_writable(project_id)
        self._atomic_write_text(
            self.data_file(project_id, data_type),
            json.dumps(data, ensure_ascii=False, indent=2),
        )

    def delete_data(self, project_id: str, data_type: str) -> bool:
        """删除一个 JSON 数据片段，供整轮撤销恢复“回合前不存在”的状态。

        Args:
            project_id: 项目 id。
            data_type: JSON 数据片段类型。

        Returns:
            文件实际存在并被删除时为 ``True``。
        """
        self.assert_writable(project_id)
        path = self.data_file(project_id, data_type)
        if not path.exists():
            return False
        path.unlink()
        return True

    def exists(self, project_id: str) -> bool:
        """判断项目是否存在。"""
        return (self._project_dir(project_id) / "meta.json").exists()

    # ── 项目生命周期 ────────────────────────────────────────────────────────
    def create_project(self, name: str) -> ProjectMeta:
        """创建一个新项目并落盘其 ``meta.json``。

        Args:
            name: 项目展示名称。

        Returns:
            新建项目的元数据。
        """
        project_id = f"{_slugify(name)}-{uuid.uuid4().hex[:8]}"
        meta = ProjectMeta(
            id=project_id,
            name=name,
            stages={dt: "empty" for dt in (*TEXT_TYPES, *DATA_TYPES)},
        )
        self._project_dir(project_id).mkdir(parents=True, exist_ok=True)
        self._write_meta(meta)
        return meta

    def list_projects(self) -> list[ProjectMeta]:
        """列出工作区内的全部项目（按更新时间倒序）。"""
        metas: list[ProjectMeta] = []
        for d in self.projects_dir.iterdir():
            meta_path = d / "meta.json"
            if meta_path.exists():
                metas.append(ProjectMeta.model_validate_json(meta_path.read_text("utf-8")))
        return sorted(metas, key=lambda m: m.updated_at, reverse=True)

    # ── 元数据读写 ──────────────────────────────────────────────────────────
    def load_meta(self, project_id: str) -> ProjectMeta:
        """读取项目元数据。"""
        meta_path = self._project_dir(project_id) / "meta.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"项目不存在: {project_id}")
        return ProjectMeta.model_validate_json(meta_path.read_text("utf-8"))

    def _write_meta(self, meta: ProjectMeta) -> None:
        """落盘项目元数据；空的旧版依赖基线字段不再写入新项目。"""
        self.assert_writable(meta.id)
        meta_path = self._project_dir(meta.id) / "meta.json"
        payload = meta.model_dump()
        for legacy_field in ("based_on", "scene_based_on"):
            if not payload[legacy_field]:
                payload.pop(legacy_field)
        self._atomic_write_text(
            meta_path,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )

    def restore_version_fields(
        self,
        project_id: str,
        *,
        revisions: dict[str, int],
        stages: dict[str, str],
        scene_revisions: dict[str, int],
        updated_at: str | None = None,
    ) -> None:
        """把 revision / 阶段状态恢复为指定快照，供失败回合整轮回滚。

        与 :meth:`bump_revision` 不同，本方法不递增版本，而是写回回合开始前的值，
        使失败回合看起来从未正式写入。

        Args:
            project_id: 项目 id。
            revisions: 片段 revision 快照。
            stages: 片段阶段状态快照。
            scene_revisions: 按事件情节 revision 快照。
            updated_at: 若提供则同时恢复 ``updated_at``；否则只更新内容版本字段。
        """
        meta = self.load_meta(project_id)
        meta.revisions = dict(revisions)
        meta.stages = dict(stages)
        meta.scene_revisions = dict(scene_revisions)
        if updated_at is not None:
            meta.updated_at = updated_at
        self._write_meta(meta)

    # ── 素材库（多份纯文本，存于 materials/ 子目录）──────────────────────────
    # 用户可上传任意数量的 .md/.txt/.json 素材；Agent 经 /project/materials/ 只读
    # （先 ls 再逐个读）。素材是**可选**的：没有素材也能基于对话推进创作。
    def materials_dir(self, project_id: str) -> Path:
        """返回某项目的素材库目录（``materials/``）。"""
        return self._project_dir(project_id) / "materials"

    @staticmethod
    def _safe_material_name(filename: str) -> str:
        """把上传文件名规范为安全的素材文件名（取 basename + 校验后缀 + 防目录穿越）。

        Args:
            filename: 客户端给的原始文件名。

        Returns:
            清洗后的文件名（不含路径分量）。

        Raises:
            ValueError: 文件名为空/隐藏文件，或后缀不在 :data:`MATERIAL_EXTS` 白名单内。
        """
        name = Path(filename or "").name.strip()
        if not name or name.startswith("."):
            raise ValueError("文件名非法")
        if Path(name).suffix.lower() not in MATERIAL_EXTS:
            raise ValueError(f"仅支持 {'/'.join(MATERIAL_EXTS)} 纯文本素材")
        return name

    def list_materials(self, project_id: str) -> list[dict]:
        """列出素材库中的素材（按文件名排序）。

        Returns:
            ``[{"name": str, "size": int}]``；目录不存在时返回空列表。
        """
        d = self.materials_dir(project_id)
        if not d.exists():
            return []
        items = [
            {"name": f.name, "size": f.stat().st_size}
            for f in d.iterdir()
            if f.is_file() and f.suffix.lower() in MATERIAL_EXTS
        ]
        return sorted(items, key=lambda x: x["name"])

    def add_material(self, project_id: str, filename: str, content: str) -> str:
        """新增/覆盖一份素材（同名则覆盖）。

        Args:
            project_id: 项目 id。
            filename: 素材文件名（仅取 basename，须为白名单后缀）。
            content: 纯文本内容。

        Returns:
            实际写入的文件名。

        Raises:
            ValueError: 文件名非法或后缀不被支持。
        """
        self.assert_writable(project_id)
        name = self._safe_material_name(filename)
        d = self.materials_dir(project_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(content, "utf-8")
        return name

    def get_material(self, project_id: str, filename: str) -> str:
        """读取某份素材内容；不存在时返回空字符串。"""
        name = self._safe_material_name(filename)
        f = self.materials_dir(project_id) / name
        return f.read_text("utf-8") if f.exists() else ""

    def get_material_chunk(
        self,
        project_id: str,
        filename: str,
        *,
        offset: int,
        limit: int,
    ) -> dict:
        """按字符偏移读取一段素材正文。

        Args:
            project_id: 项目稳定 id。
            filename: 经过素材文件名规则校验的文件名。
            offset: 从零开始的 Unicode 字符偏移。
            limit: 本次最多返回的 Unicode 字符数。

        Returns:
            文件名、正文片段、总字符数、下一偏移和是否完整。

        Raises:
            FileNotFoundError: 素材不存在。
            ValueError: 文件名、偏移或分段长度非法。
        """
        if offset < 0 or limit <= 0:
            raise ValueError("素材预览偏移和长度必须为非负偏移、正数长度")
        name = self._safe_material_name(filename)
        path = self.materials_dir(project_id) / name
        if not path.exists():
            raise FileNotFoundError(name)
        content = path.read_text("utf-8")
        total_chars = len(content)
        chunk = content[offset : offset + limit]
        next_offset = min(offset + len(chunk), total_chars)
        return {
            "name": name,
            "content": chunk,
            "offset": offset,
            "next_offset": next_offset,
            "total_chars": total_chars,
            "complete": next_offset >= total_chars,
        }

    def delete_material(self, project_id: str, filename: str) -> bool:
        """删除某份素材；返回是否确有文件被删除。"""
        self.assert_writable(project_id)
        name = self._safe_material_name(filename)
        f = self.materials_dir(project_id) / name
        if f.exists():
            f.unlink()
            return True
        return False

    # ── 配图库（角色/地点卡片的图片，存于 assets/ 子目录，见 DESIGN §5.8）──────
    # 二进制图片，独立于只收纯文本的 materials/。卡片以相对路径 ``assets/<name>`` 引用；
    # 落盘用 uuid 唯一名避免同名覆盖；手动上传、面板生图和 Agent 生图共用本存储能力。
    def assets_dir(self, project_id: str) -> Path:
        """返回某项目的配图目录（``assets/``）。"""
        return self._project_dir(project_id) / "assets"

    @staticmethod
    def _asset_ext(filename: str) -> str:
        """校验并返回图片后缀（小写，含点）。

        Args:
            filename: 客户端给的原始文件名（仅用于取后缀）。

        Returns:
            合法的小写后缀（如 ``".png"``）。

        Raises:
            ValueError: 后缀不在 :data:`ASSET_EXTS` 白名单内。
        """
        ext = Path(filename or "").suffix.lower()
        if ext not in ASSET_EXTS:
            raise ValueError(f"仅支持 {'/'.join(ASSET_EXTS)} 图片")
        return ext

    def add_asset(self, project_id: str, filename: str, data: bytes) -> str:
        """保存一张配图（生成 uuid 唯一名，避免同名冲突）。

        Args:
            project_id: 项目 id。
            filename: 原始文件名（仅用于取后缀判类型）。
            data: 图片二进制内容。

        Returns:
            落盘后的文件名（形如 ``"<uuid>.png"``；卡片以 ``assets/<name>`` 引用）。

        Raises:
            ValueError: 后缀非法或大小超过 :data:`ASSET_MAX_BYTES`。
        """
        self.assert_writable(project_id)
        ext = self._asset_ext(filename)
        if len(data) > ASSET_MAX_BYTES:
            raise ValueError(f"图片过大（上限 {ASSET_MAX_BYTES // (1024 * 1024)}MB）")
        d = self.assets_dir(project_id)
        d.mkdir(parents=True, exist_ok=True)
        name = f"{uuid.uuid4().hex}{ext}"
        (d / name).write_bytes(data)
        return name

    def asset_path(self, project_id: str, filename: str) -> Path | None:
        """返回某配图的文件路径；不存在或文件名越界时返回 ``None``（防目录穿越）。"""
        name = Path(filename or "").name  # 只取 basename，杜绝 ../ 穿越
        if not name:
            return None
        f = self.assets_dir(project_id) / name
        return f if f.exists() and f.is_file() else None

    def delete_asset(self, project_id: str, filename: str) -> bool:
        """删除项目 ``assets/`` 下的一张图片。

        Args:
            project_id: 项目 id。
            filename: 图片文件名或 ``assets/<name>`` 相对路径；只使用 basename，防止目录穿越。

        Returns:
            文件实际存在并被删除时返回 ``True``，不存在或名称为空时返回 ``False``。
        """
        self.assert_writable(project_id)
        path = self.asset_path(project_id, filename)
        if path is None:
            return False
        path.unlink()
        return True

    def write_asset_bytes(self, project_id: str, filename: str, data: bytes) -> str:
        """按既有文件名写回配图，供失败回合把 ``assets/`` 恢复到基线。

        Args:
            project_id: 项目 id。
            filename: 目标文件名；只使用 basename，防止目录穿越。
            data: 图片二进制内容。

        Returns:
            实际写入的文件名。

        Raises:
            ValueError: 文件名为空。
        """
        self.assert_writable(project_id)
        name = Path(filename or "").name
        if not name or name.startswith("."):
            raise ValueError("非法配图文件名")
        directory = self.assets_dir(project_id)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_bytes(data)
        return name

    # ── 对话记录（面向展示的持久化 transcript，见 DESIGN §6.9）──────────────
    # 与 Agent 内部上下文（``ProjectSession.messages``，内存态、可重建）分离：这里只存
    # "给用户看的对话流"（user/assistant/system 文本 + 工具步骤），逐行 JSON 追加，
    # 进程重启或重进项目后仍可还原前端对话。
    def chat_file(self, project_id: str) -> Path:
        """返回某项目的对话记录文件路径（``chat.jsonl``）。"""
        return self._project_dir(project_id) / "chat.jsonl"

    def append_chat(self, project_id: str, entry: dict) -> None:
        """向对话记录追加一条消息（一行 JSON）。

        Args:
            project_id: 项目 id。
            entry: 可 JSON 序列化的消息，约定含 ``role``（user/assistant/system）与
                ``text``；assistant 可带 ``steps``（``[{label, done}]``）。
        """
        self.assert_writable(project_id)
        line = json.dumps(entry, ensure_ascii=False)
        with self.chat_file(project_id).open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def get_chat(self, project_id: str) -> list[dict]:
        """读取某项目的全部对话记录；不存在或损坏行跳过，返回消息列表。"""
        p = self.chat_file(project_id)
        if not p.exists():
            return []
        messages: list[dict] = []
        for line in p.read_text("utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                messages.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # 跳过损坏行，尽量还原其余历史
        return messages

    # ── 场景层（阶段 4）：每事件一张情节图，存于 scenes/<event_id>.json ─────────
    # 按事件分文件（贴合"只读写某片段"），版本/标脏按事件独立维护（见 DESIGN §4.2(g)）。
    def scenes_dir(self, project_id: str) -> Path:
        """返回某项目的场景目录（``scenes/``）。"""
        return self._project_dir(project_id) / "scenes"

    @staticmethod
    def _safe_event_id(event_id: str) -> str:
        """把事件 id 规范为安全的文件名分量（取 basename + 防目录穿越）。

        Args:
            event_id: 事件节点 id。

        Returns:
            清洗后的事件 id（不含路径分量）。

        Raises:
            ValueError: 事件 id 为空或规范化后为空。
        """
        name = Path(event_id or "").name.strip()
        if not name or name.startswith("."):
            raise ValueError("非法事件 id")
        return name

    def scene_file(self, project_id: str, event_id: str) -> Path:
        """返回某事件情节图对应的 JSON 文件路径（``scenes/<event_id>.json``）。"""
        return self.scenes_dir(project_id) / f"{self._safe_event_id(event_id)}.json"

    def get_scene(self, project_id: str, event_id: str) -> dict | None:
        """读取某事件的情节图；不存在或无法解析时返回 ``None``。"""
        f = self.scene_file(project_id, event_id)
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text("utf-8"))
        except json.JSONDecodeError:
            return None

    def set_scene(self, project_id: str, event_id: str, data: dict) -> None:
        """写入某事件的情节图到磁盘（不负责校验与版本登记）。"""
        self.assert_writable(project_id)
        self._atomic_write_text(
            self.scene_file(project_id, event_id),
            json.dumps(data, ensure_ascii=False, indent=2),
        )

    def delete_scene(self, project_id: str, event_id: str) -> bool:
        """删除某事件的情节图文件；返回是否确有文件被删除（不动 meta 中的版本记录）。"""
        self.assert_writable(project_id)
        f = self.scene_file(project_id, event_id)
        if f.exists():
            f.unlink()
            return True
        return False

    def list_scene_event_ids(self, project_id: str) -> list[str]:
        """列出已生成情节图的事件 id（即 ``scenes/`` 下的 ``<event_id>.json``，按名排序）。"""
        d = self.scenes_dir(project_id)
        if not d.exists():
            return []
        return sorted(f.stem for f in d.iterdir() if f.is_file() and f.suffix == ".json")

    def scenes_snapshot(self, project_id: str) -> dict[str, float]:
        """对全部情节图文件做 mtime 快照（``{event_id: mtime}``），供回合前后对比。"""
        d = self.scenes_dir(project_id)
        if not d.exists():
            return {}
        return {
            f.stem: f.stat().st_mtime
            for f in d.iterdir()
            if f.is_file() and f.suffix == ".json"
        }

    def scenes_changed_since(self, project_id: str, snapshot: dict[str, float]) -> list[str]:
        """对比快照，返回自快照以来新增/修改的情节图对应的事件 id 列表。"""
        changed: list[str] = []
        for event_id, mtime in self.scenes_snapshot(project_id).items():
            if event_id not in snapshot or mtime != snapshot[event_id]:
                changed.append(event_id)
        return changed

    # ── 主动检测记录（见 DESIGN §4.8/§4.9）─────────────────────────────────
    def validation_dir(self, project_id: str) -> Path:
        """返回项目的检测记录目录。"""
        return self._project_dir(project_id) / "validation"

    def validation_file(self, project_id: str) -> Path:
        """返回最近一次完整检测记录 ``validation/latest.json``。"""
        return self.validation_dir(project_id) / "latest.json"

    @staticmethod
    def _canonical_json_digest_bytes(raw: bytes | None) -> str | None:
        """计算一份 JSON 字节内容的规范化 SHA-256；``None`` 表示文件不存在。

        合法 JSON 先按键排序、去除无意义空白再计算，避免仅格式化文件就让检测失效。非法 JSON
        仍按原始字节计算并加前缀，使外部破坏文件时一定与旧记录不同。
        """
        if raw is None:
            return None
        try:
            value = json.loads(raw.decode("utf-8"))
            canonical = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        except (UnicodeDecodeError, json.JSONDecodeError):
            canonical = b"INVALID_JSON\0" + raw
        return hashlib.sha256(canonical).hexdigest()

    @classmethod
    def _canonical_json_digest(cls, path: Path) -> str | None:
        """读取 JSON 文件一次并计算规范化摘要。"""
        raw = path.read_bytes() if path.exists() else None
        return cls._canonical_json_digest_bytes(raw)

    @staticmethod
    def _world_identity_from_raw(raw: bytes | None) -> tuple[str | None, dict | None]:
        """从 world.json 字节计算卡片身份摘要，并尽量解析正文。

        只纳入分类 + 卡片 id。文件缺失返回 ``(None, None)``；非法 JSON 用与事件图相同的
        ``INVALID_JSON`` 哨兵，避免与空设定或缺失文件撞指纹。
        """
        if raw is None:
            return None, None
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            digest = hashlib.sha256(b"INVALID_JSON\0" + raw).hexdigest()
            return digest, None
        if not isinstance(parsed, dict):
            digest = hashlib.sha256(b"INVALID_JSON\0" + raw).hexdigest()
            return digest, None
        return world_card_identity_digest(parsed), parsed

    @staticmethod
    def _build_validation_fingerprint(
        *,
        events_digest: str | None,
        scene_parts: dict[str, str | None],
        expected_ids: list[str],
        actual_ids: list[str],
        world_identity_digest: str | None,
    ) -> dict:
        """由已读取内容的分项摘要组装总指纹。"""
        lines = [
            f"events:{events_digest or 'null'}",
            f"world_identity:{world_identity_digest or 'null'}",
        ]
        lines.extend(
            f"scene:{event_id}:{scene_parts[event_id] or 'null'}"
            for event_id in sorted(scene_parts)
        )
        digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
        return {
            "algorithm": "sha256",
            "digest": digest,
            "parts": {
                "events": events_digest,
                "scenes": scene_parts,
                "world_identity": world_identity_digest,
            },
            "expected_scene_ids": expected_ids,
            "present_scene_ids": actual_ids,
        }

    def validation_fingerprint(self, project_id: str) -> dict:
        """为当前事件图、世界卡片身份与全部情节图计算内容指纹。

        指纹同时记录事件图期待的 scene 和磁盘上的额外 scene。缺失情节以 ``null`` 纳入，
        因此新增、删除、修改或外部直写任何运行数据都会改变总摘要。世界设定只纳入
        「分类 + 卡片 id」身份，名称/描述/配图变化不改变指纹。
        """
        events_path = self.data_file(project_id, "events")
        events_digest = self._canonical_json_digest(events_path)
        world_path = self.data_file(project_id, "world")
        world_raw = world_path.read_bytes() if world_path.exists() else None
        world_identity_digest, _world = self._world_identity_from_raw(world_raw)
        events = self.get_data(project_id, "events")
        raw_nodes = events.get("nodes", []) if isinstance(events, dict) else []
        if not isinstance(raw_nodes, list):
            raw_nodes = []
        expected_ids = sorted(
            {
                node.get("id")
                for node in raw_nodes
                if isinstance(node, dict) and node.get("id")
            }
        )
        actual_ids = self.list_scene_event_ids(project_id)
        all_scene_ids = sorted(set(expected_ids) | set(actual_ids))
        scene_parts = {
            event_id: self._canonical_json_digest(self.scene_file(project_id, event_id))
            for event_id in all_scene_ids
        }
        return self._build_validation_fingerprint(
            events_digest=events_digest,
            scene_parts=scene_parts,
            expected_ids=expected_ids,
            actual_ids=actual_ids,
            world_identity_digest=world_identity_digest,
        )

    def load_validation_snapshot(self, project_id: str) -> dict:
        """一次性读取正式检测所需内容，并用同一批字节计算输入指纹。

        Returns:
            包含 ``fingerprint``、解析后的 ``events``/``scenes``/``world``，以及无法解析的 scene id。
            检测器只使用这里返回的数据，避免先算指纹后又读到另一版本内容。
        """
        events_path = self.data_file(project_id, "events")
        events_raw = events_path.read_bytes() if events_path.exists() else None
        events: dict | None = None
        if events_raw is not None:
            try:
                parsed = json.loads(events_raw.decode("utf-8"))
                events = parsed if isinstance(parsed, dict) else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                events = None

        world_path = self.data_file(project_id, "world")
        world_raw = world_path.read_bytes() if world_path.exists() else None
        world_identity_digest, world = self._world_identity_from_raw(world_raw)

        raw_nodes = events.get("nodes", []) if isinstance(events, dict) else []
        if not isinstance(raw_nodes, list):
            raw_nodes = []
        expected_ids = sorted(
            {
                node.get("id")
                for node in raw_nodes
                if isinstance(node, dict) and node.get("id")
            }
        )
        actual_ids = self.list_scene_event_ids(project_id)
        all_scene_ids = sorted(set(expected_ids) | set(actual_ids))

        scenes: list[dict] = []
        invalid_scene_ids: list[str] = []
        scene_parts: dict[str, str | None] = {}
        for event_id in all_scene_ids:
            path = self.scene_file(project_id, event_id)
            raw = path.read_bytes() if path.exists() else None
            scene_parts[event_id] = self._canonical_json_digest_bytes(raw)
            if raw is None:
                continue
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                invalid_scene_ids.append(event_id)
                continue
            if isinstance(parsed, dict):
                scenes.append(parsed)
            else:
                invalid_scene_ids.append(event_id)

        return {
            "fingerprint": self._build_validation_fingerprint(
                events_digest=self._canonical_json_digest_bytes(events_raw),
                scene_parts=scene_parts,
                expected_ids=expected_ids,
                actual_ids=actual_ids,
                world_identity_digest=world_identity_digest,
            ),
            "events": events,
            "scenes": scenes,
            "world": world,
            "invalid_scene_ids": invalid_scene_ids,
        }

    def get_validation_record(self, project_id: str) -> dict | None:
        """读取最近一次检测记录；不存在或损坏时返回 ``None``。"""
        path = self.validation_file(project_id)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None

    def save_validation_record(
        self,
        project_id: str,
        *,
        fingerprint: dict,
        report: dict,
    ) -> dict:
        """保存一次完整检测的输入指纹和报告，并返回落盘记录。"""
        self.assert_writable(project_id)
        from narrative_forge.core.models.project import _now_iso

        record = {
            "version": 1,
            "checked_at": _now_iso(),
            "fingerprint": fingerprint,
            "status": report.get("status", "failed"),
            "engine_version": report.get("engine_version"),
            "report_schema_version": report.get("report_schema_version"),
            "report": report,
        }
        target = self.validation_file(project_id)
        self._atomic_write_text(
            target,
            json.dumps(record, ensure_ascii=False, indent=2),
        )
        return record

    def replace_validation_record_text(
        self,
        project_id: str,
        text: str | None,
    ) -> None:
        """把 ``validation/latest.json`` 恢复为指定文本，或删除该文件。

        Args:
            project_id: 项目 id。
            text: 回合开始前的检测记录原文；``None`` 表示当时没有正式记录。
        """
        self.assert_writable(project_id)
        path = self.validation_file(project_id)
        if text is None:
            if path.exists():
                path.unlink()
            return
        self._atomic_write_text(path, text)

    def validation_state(self, project_id: str) -> dict:
        """返回最近检测是否仍适用于当前内容。

        若当前指纹与记录不一致，只返回 ``not_checked``，旧报告不作为当前结论展示。
        """
        current = self.validation_fingerprint(project_id)
        record = self.get_validation_record(project_id)
        if record is None:
            return {
                "status": "not_checked",
                "current_fingerprint": current["digest"],
                "checked_at": None,
                "report": None,
            }
        from narrative_forge.core.models.state_validation import (
            ENGINE_VERSION,
            REPORT_SCHEMA_VERSION,
        )

        recorded = record.get("fingerprint")
        recorded_digest = recorded.get("digest") if isinstance(recorded, dict) else None
        version_matches = (
            record.get("engine_version") == ENGINE_VERSION
            and record.get("report_schema_version") == REPORT_SCHEMA_VERSION
        )
        if recorded_digest != current["digest"] or not version_matches:
            return {
                "status": "not_checked",
                "current_fingerprint": current["digest"],
                "checked_at": record.get("checked_at"),
                "report": None,
            }
        return {
            "status": record.get("status", "failed"),
            "current_fingerprint": current["digest"],
            "checked_at": record.get("checked_at"),
            "report": record.get("report"),
        }

    def bump_scene_revision(self, project_id: str, event_id: str, stage: str = "ready") -> int:
        """提升某事件情节图的 revision。

        用于"情节图已由 Agent 写盘、校验通过后由编排层登记版本"的场景。版本按事件
        独立维护于 ``meta.scene_revisions``。历史 ``scene_based_on`` 数据保留但不再更新。

        Args:
            project_id: 项目 id。
            event_id: 事件 id。
            stage: 预留（当前不写入独立 stage 表，场景状态由 revision/存在性派生）。

        Returns:
            更新后的该事件情节图 revision。
        """
        from narrative_forge.core.models.project import _now_iso

        meta = self.load_meta(project_id)
        meta.scene_revisions[event_id] = meta.scene_revisions.get(event_id, 0) + 1
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        return meta.scene_revisions[event_id]

    # ── 自由文本片段（创作意图 intent 等，不走 JSON 校验）────────────────────
    def text_file(self, project_id: str, data_type: str) -> Path:
        """返回某自由文本片段（如 ``intent``）对应的文件路径。"""
        return self._project_dir(project_id) / _TEXT_FILES[data_type]

    def get_text(self, project_id: str, data_type: str) -> str:
        """读取某自由文本片段（如 ``intent``）；不存在时返回空字符串。"""
        p = self.text_file(project_id, data_type)
        return p.read_text("utf-8") if p.exists() else ""

    def set_text(self, project_id: str, data_type: str, text: str) -> None:
        """写入某自由文本片段（如 ``intent``）。"""
        self.assert_writable(project_id)
        self._atomic_write_text(self.text_file(project_id, data_type), text)

    def delete_text(self, project_id: str, data_type: str) -> bool:
        """删除一个自由文本片段，供整轮撤销恢复不存在状态。

        Args:
            project_id: 项目 id。
            data_type: 自由文本片段类型。

        Returns:
            文件实际存在并被删除时为 ``True``。
        """
        self.assert_writable(project_id)
        path = self.text_file(project_id, data_type)
        if not path.exists():
            return False
        path.unlink()
        return True

    def get_intent(self, project_id: str) -> str:
        """读取创作意图（``intent.md``）；不存在时返回空字符串。"""
        return self.get_text(project_id, "intent")

    def set_intent(self, project_id: str, text: str) -> None:
        """写入创作意图（``intent.md``）。"""
        self.set_text(project_id, "intent", text)

    def text_mtime(self, project_id: str, data_type: str) -> float | None:
        """返回某自由文本片段文件的 mtime；不存在返回 ``None``（用于回合变更检测）。"""
        p = self.text_file(project_id, data_type)
        return p.stat().st_mtime if p.exists() else None

    # ── 变更检测与版本维护（供编排层回合末使用）──────────────────────────────
    def snapshot(self, project_id: str) -> dict[str, float]:
        """对各数据片段文件做一次"指纹"快照（用文件 mtime）。

        用于回合前后对比，判断 Agent 这一轮实际改动了哪些片段。

        Returns:
            ``{data_type: mtime}``；文件不存在的片段不出现在结果中。
        """
        snap: dict[str, float] = {}
        for dt in DATA_TYPES:
            f = self.data_file(project_id, dt)
            if f.exists():
                snap[dt] = f.stat().st_mtime
        return snap

    def changed_since(self, project_id: str, snapshot: dict[str, float]) -> list[str]:
        """对比快照，返回自快照以来发生变化（新增或修改）的 data_type 列表。"""
        changed: list[str] = []
        for dt in DATA_TYPES:
            f = self.data_file(project_id, dt)
            if not f.exists():
                continue
            if dt not in snapshot or f.stat().st_mtime != snapshot[dt]:
                changed.append(dt)
        return changed

    def bump_revision(self, project_id: str, data_type: str, stage: str = "ready") -> int:
        """提升某片段的 revision 并更新阶段状态（不改文件内容本身）。

        用于"文件已由 Agent 直接写入磁盘、校验通过后由编排层登记版本"的场景。

        Args:
            project_id: 项目 id。
            data_type: 数据类型。
            stage: 该片段的新阶段状态，默认 ``"ready"``。

        Returns:
            更新后的 revision。
        """
        from narrative_forge.core.models.project import _now_iso

        meta = self.load_meta(project_id)
        meta.revisions[data_type] = meta.revisions.get(data_type, 0) + 1
        meta.stages[data_type] = stage
        # 历史 based_on 数据只为旧项目反序列化兼容而保留，不再更新或派生产品状态。
        meta.updated_at = _now_iso()
        self._write_meta(meta)
        return meta.revisions[data_type]

    def set_stage(self, project_id: str, data_type: str, stage: str) -> None:
        """仅更新某片段的阶段状态（如校验失败时标记 ``"error"``），不动 revision。"""
        from narrative_forge.core.models.project import _now_iso

        meta = self.load_meta(project_id)
        meta.stages[data_type] = stage
        meta.updated_at = _now_iso()
        self._write_meta(meta)

