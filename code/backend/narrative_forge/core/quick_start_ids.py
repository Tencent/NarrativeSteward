"""内置快速上手教学样例的固定 id、路径与只读错误。

查找只靠这些内部 id，不靠展示名称。资源目录随代码发布，运行时不写入。
"""

from __future__ import annotations
import os
from pathlib import Path
from importlib.resources import files


class ReadOnlyProjectError(Exception):
    """内置只读教学样例拒绝写入、删除或建目录。"""


BUILTIN_QUICK_START_ID_BY_LOCALE = {
    "zh-CN": "_builtin_quick_start_zh",
    "en-US": "_builtin_quick_start_en",
}
BUILTIN_QUICK_START_DIRNAME_BY_LOCALE = {"zh-CN": "zh", "en-US": "en"}
BUILTIN_QUICK_START_IDS = frozenset(BUILTIN_QUICK_START_ID_BY_LOCALE.values())


def is_builtin_quick_start_id(project_id: str | None) -> bool:
    """判断内部 id 是否为代码包内的教学样例。"""
    return bool(project_id) and project_id in BUILTIN_QUICK_START_IDS


def builtin_quick_start_id(locale: str) -> str:
    """返回指定语言教学样例的固定内部 id。"""
    if locale not in BUILTIN_QUICK_START_ID_BY_LOCALE:
        raise KeyError(f"不支持的教学样例语言: {locale}")
    return BUILTIN_QUICK_START_ID_BY_LOCALE[locale]


def builtin_quick_start_dirname(locale: str) -> str:
    """返回指定语言教学样例在资源包内的目录名。"""
    if locale not in BUILTIN_QUICK_START_DIRNAME_BY_LOCALE:
        raise KeyError(f"不支持的教学样例语言: {locale}")
    return BUILTIN_QUICK_START_DIRNAME_BY_LOCALE[locale]


def locale_for_builtin_quick_start(project_id: str) -> str | None:
    """若 id 为内置教学样例，返回其语言；否则返回 ``None``。"""
    for locale, builtin_id in BUILTIN_QUICK_START_ID_BY_LOCALE.items():
        if builtin_id == project_id:
            return locale
    return None


def quick_start_resource_root() -> Path:
    """返回内置教学样例根目录的真实文件系统路径。

    优先用 ``importlib.resources``，以便安装后的包也能读到；源码运行时再回退到
    ``narrative_forge/resources/quick_start/``。
    """
    candidates: list[Path] = []
    try:
        traversable = files("narrative_forge.resources.quick_start")
        candidates.append(Path(os.fspath(traversable)))
    except (ModuleNotFoundError, TypeError, FileNotFoundError, ValueError):
        pass
    candidates.append(Path(__file__).resolve().parents[1] / "resources" / "quick_start")
    for candidate in candidates:
        if (candidate / "manifest.json").is_file():
            return candidate
    raise FileNotFoundError(
        "找不到内置教学样例清单 resources/quick_start/manifest.json"
    )


def builtin_quick_start_project_dir(project_id: str) -> Path | None:
    """若 id 为内置教学样例，返回其包内项目目录；否则返回 ``None``。"""
    locale = locale_for_builtin_quick_start(project_id)
    if locale is None:
        return None
    return quick_start_resource_root() / builtin_quick_start_dirname(locale)
