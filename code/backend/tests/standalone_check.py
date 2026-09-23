"""Offline extraction contract: no study API, isolated data and read-only tutorials."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile


def resource_hashes(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    }


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ns_standalone_") as tmp:
        os.environ["NARRATIVE_FORGE_WORKSPACE"] = tmp
        from fastapi.testclient import TestClient
        from narrative_forge.api.app import create_app
        from narrative_forge.core.quick_start_ids import quick_start_resource_root

        root = quick_start_resource_root()
        before = resource_hashes(root)
        app = create_app()
        with TestClient(app) as client:
            assert client.get("/api/health").json() == {"status": "ok"}
            assert all("/research" not in path for path in app.openapi()["paths"])
            assert client.get("/api/research/tasks").status_code == 404
            assert client.get("/api/projects").json()["projects"] == []
            for locale in ("zh-CN", "en-US"):
                info = client.get(
                    "/api/quick-start/demo", params={"locale": locale}
                ).json()
                assert info["locale"] == locale and info["read_only"] is True
                prefix = "/api/projects/" + info["project_id"]
                for suffix in (
                    "",
                    "/data/world",
                    "/data/events",
                    "/history",
                    "/scenes",
                    "/validation",
                    "/reachability",
                    "/agent-changesets/latest",
                    "/assets/loc-fork.png",
                ):
                    response = client.get(prefix + suffix)
                    assert response.status_code == 200, (suffix, response.text[:200])
                for method, suffix, body in (
                    (
                        "PUT",
                        "/data/intent",
                        {"content": "overwrite", "base_revision": 0},
                    ),
                    ("POST", "/chat", {"message": "overwrite"}),
                    ("POST", "/chat/stop", None),
                    ("POST", "/validation/run", None),
                    (
                        "POST",
                        "/materials",
                        {"filename": "notes.md", "content": "overwrite"},
                    ),
                    ("DELETE", "/materials/Demo notes.md", None),
                ):
                    response = client.request(method, prefix + suffix, json=body)
                    assert response.status_code == 423, (suffix, response.text[:200])
            assert client.get("/api/projects").json()["projects"] == []
            response = client.post(
                "/api/projects", json={"name": "Standalone authoring"}
            )
            assert response.status_code in (200, 201)
            project_id = response.json()["id"]
            prefix = "/api/projects/" + project_id
            assert (
                client.put(
                    prefix + "/data/intent",
                    json={"content": "A branching story.", "base_revision": 0},
                ).status_code
                == 200
            )
            assert (
                client.get(prefix + "/data/intent").json()["content"]
                == "A branching story."
            )
        with TestClient(create_app()) as reopened:
            assert (
                reopened.get(prefix + "/data/intent").json()["content"]
                == "A branching story."
            )
        assert resource_hashes(root) == before, "tutorial resources were modified"
        assert not (Path(tmp) / "research").exists()
    print(
        "standalone_check: bilingual tutorial, read-only, persistence and no study API pass"
    )


if __name__ == "__main__":
    main()
