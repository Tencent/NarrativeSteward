"""Resolve bundled, read-only tutorials without creating or migrating user data."""

from __future__ import annotations
import json
from typing import Any
from narrative_forge.agents.prompts import normalize_response_locale
from narrative_forge.core.quick_start_ids import (
    BUILTIN_QUICK_START_IDS,
    builtin_quick_start_id,
    is_builtin_quick_start_id,
    quick_start_resource_root,
)
from narrative_forge.core.store import ProjectStore


def load_quick_start_manifest() -> dict[str, Any]:
    return json.loads(
        (quick_start_resource_root() / "manifest.json").read_text(encoding="utf-8")
    )


class QuickStartDemoService:
    def __init__(self, project_store: ProjectStore):
        self.project_store = project_store

    def project_id(self, locale: str = "zh-CN") -> str:
        return builtin_quick_start_id(normalize_response_locale(locale))

    def all_demo_ids(self) -> set[str]:
        return set(BUILTIN_QUICK_START_IDS)

    def is_demo(self, project_id: str) -> bool:
        return is_builtin_quick_start_id(project_id)

    def ensure(self, locale: str = "zh-CN") -> dict[str, Any]:
        resolved = normalize_response_locale(locale)
        manifest = load_quick_start_manifest()
        item = manifest["locales"][resolved]
        project_id = item["project_id"]
        if not self.project_store.exists(project_id):
            raise FileNotFoundError(f"Missing bundled tutorial: {project_id}")
        return {
            "project_id": project_id,
            "name": item["name"],
            "read_only": True,
            "version": manifest["version"],
            "locale": resolved,
        }
