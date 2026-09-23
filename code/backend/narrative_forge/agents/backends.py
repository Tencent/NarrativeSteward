"""为 Agent 构建文件后端（CompositeBackend）。

设计（见 docs/DESIGN.md §6）：Agent 用 deepagents 内置文件工具（read/write/edit/grep/ls）
读写数据，但通过路由把不同前缀指向不同存储：

- 默认（``/``）→ ``StateBackend``：Agent 的草稿盘（todo、摘要、临时笔记），**内存态、
  不落到项目目录**，避免污染真实数据。
- ``/project/`` → 项目目录的真实磁盘：``materials/``（用户上传的素材，只读）/ ``intent.md``
  / ``outline.md`` / ``world.json`` / ``events.json`` / ``scenes/<event_id>.json`` / ``meta.json``
  都在这里。这是 Agent 实际产出数据的地方。
- ``/skills/`` → 技能目录的真实磁盘：各 ``SKILL.md``（含 JSON 模板），供 SkillsMiddleware
  经 backend 读取（它只走 backend API，不直接读盘）。

子 Agent 会自动共享主 Agent 的这个 backend（见 deepagents.graph.create_deep_agent）。
"""

from __future__ import annotations

import os
import uuid
import re
from pathlib import Path

from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from deepagents.backends.protocol import EditResult, WriteResult
from deepagents.backends.utils import perform_string_replacement
from deepagents.middleware.filesystem import FilesystemPermission

from narrative_forge.core.store import ProjectStore

# 路由前缀（Agent 看到的虚拟路径）。
PROJECT_ROUTE = "/project/"
SKILLS_ROUTE = "/skills/"

# Agent 侧使用的虚拟文件路径（写进 prompt / skill）。
PROJECT_DIR = "/project"
MATERIALS_DIR = "/project/materials"  # 素材库目录（多份纯文本素材，只读；先 ls 再逐个读）
INTENT_PATH = "/project/intent.md"
OUTLINE_PATH = "/project/outline.md"  # 弱格式大纲：自由 Markdown 文本
WORLD_PATH = "/project/world.json"
EVENTS_PATH = "/project/events.json"  # 事件图：状态变量 + 节点 + 边
SCENES_DIR = "/project/scenes"  # 场景层：每事件一张情节图 scenes/<event_id>.json
META_PATH = "/project/meta.json"

# 技能根目录（真实磁盘）：narrative_forge/skills/
SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"
# 传给 subagent 的 skills 源（经 /skills 路由后即技能根）。
SKILLS_SOURCE = SKILLS_ROUTE

# 允许文件工具写入的项目相对路径（CompositeBackend 剥掉 /project/ 前缀后）。
_ALLOWED_WRITE = re.compile(
    r"^(intent\.md|outline\.md|world\.json|events\.json|scenes/[^/]+\.json)$"
)


def creative_file_permissions() -> list[FilesystemPermission]:
    """主 Agent 与专业子 Agent 共用的硬权限：可读项目，只能写创作文件。"""
    return [
        FilesystemPermission(
            operations=["write"],
            paths=[
                "/project/intent.md",
                "/project/outline.md",
                "/project/world.json",
                "/project/events.json",
                "/project/scenes/*.json",
            ],
            mode="allow",
        ),
        FilesystemPermission(
            operations=["write"],
            paths=["/project/**"],
            mode="deny",
        ),
    ]


class AtomicFilesystemBackend(FilesystemBackend):
    """通过同目录临时文件原子提交 Agent 的文本写入。

    该后端保持 deepagents 的 ``write``（只创建新文件）和 ``edit``（字符串替换）接口，只改变最终
    落盘方式，避免读取者看到半写文件。它不保存旧版本，也不提供回退。写入还强制创作文件白名单，
    禁止改 meta、素材、检测记录、对话和配图目录。
    """

    def _relative_posix(self, resolved: Path) -> str:
        """把已解析路径变成相对项目根的 posix 路径。"""
        root = Path(getattr(self, "cwd", getattr(self, "root_dir", resolved)))
        try:
            return resolved.resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            return resolved.name

    def _deny_protected_write(self, file_path: str) -> str | None:
        """受保护路径拒绝写入；允许时返回 ``None``。"""
        try:
            resolved = self._resolve_path(file_path)
        except Exception:
            return f"Error writing file '{file_path}': invalid path"
        relative = self._relative_posix(resolved)
        if _ALLOWED_WRITE.match(relative):
            return None
        return (
            f"Cannot write to {file_path}: Agent 只能修改创作意图、大纲、世界设定、"
            "事件网络和情节文件，不能改元数据、素材、检测记录或配图目录。"
        )

    @staticmethod
    def _replace_text(target: Path, content: str) -> None:
        """完整写入随机临时文件后替换目标。"""
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(temporary, flags, 0o644)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
                stream.write(content)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()

    def write(self, file_path: str, content: str) -> WriteResult:
        """原子创建新文件；目标已存在时保持 deepagents 的拒绝语义。"""
        denied = self._deny_protected_write(file_path)
        if denied:
            return WriteResult(error=denied)
        try:
            resolved = self._resolve_path(file_path)
            if resolved.exists():
                return WriteResult(
                    error=(
                        f"Cannot write to {file_path} because it already exists. "
                        "Read and then make an edit, or write to a new path."
                    )
                )
            self._replace_text(resolved, content)
            return WriteResult(path=file_path)
        except (OSError, RuntimeError, UnicodeEncodeError) as exc:
            return WriteResult(error=f"Error writing file '{file_path}': {exc}")

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        """在内存中完成字符串替换，再原子提交完整文件。"""
        denied = self._deny_protected_write(file_path)
        if denied:
            return EditResult(error=denied)
        try:
            resolved = self._resolve_path(file_path)
            if not resolved.exists() or not resolved.is_file():
                return EditResult(error=f"Error: File '{file_path}' not found")
            content = resolved.read_text("utf-8")
            old_string = old_string.replace("\r\n", "\n").replace("\r", "\n")
            new_string = new_string.replace("\r\n", "\n").replace("\r", "\n")
            result = perform_string_replacement(
                content,
                old_string,
                new_string,
                replace_all,
            )
            if isinstance(result, str):
                return EditResult(error=result)
            next_content, occurrences = result
            self._replace_text(resolved, next_content)
            return EditResult(path=file_path, occurrences=int(occurrences))
        except (OSError, RuntimeError, UnicodeDecodeError, UnicodeEncodeError) as exc:
            return EditResult(error=f"Error editing file '{file_path}': {exc}")


def build_project_backend(store: ProjectStore, project_id: str) -> CompositeBackend:
    """构建绑定到某项目的 CompositeBackend。

    Args:
        store: 项目存储。
        project_id: 当前会话操作的项目 id。

    Returns:
        路由好的 CompositeBackend：草稿走内存，``/project`` 与 ``/skills`` 走真实磁盘。
    """
    project_dir = store.project_path(project_id)
    project_dir.mkdir(parents=True, exist_ok=True)
    return CompositeBackend(
        default=StateBackend(),
        routes={
            PROJECT_ROUTE: AtomicFilesystemBackend(
                root_dir=str(project_dir),
                virtual_mode=True,
            ),
            SKILLS_ROUTE: FilesystemBackend(root_dir=str(SKILLS_DIR), virtual_mode=True),
        },
    )
