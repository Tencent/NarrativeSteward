"""Run offline backend checks from any directory, without credentials or live calls."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> int:
    backend = Path(__file__).resolve().parents[1] / "code" / "backend"
    checks = sorted((backend / "tests").glob("*_check.py"))
    failed = []
    with tempfile.TemporaryDirectory(prefix="narrativesteward_checks_") as tmp:
        env = {
            **os.environ,
            "PYTHONPATH": str(backend),
            "NARRATIVE_FORGE_WORKSPACE": tmp,
        }
        for check in checks:
            print(f"Running {check.name}", flush=True)
            try:
                result = subprocess.run(
                    [sys.executable, str(check)], cwd=backend, env=env, timeout=240
                )
                if result.returncode:
                    failed.append(check.name)
            except subprocess.TimeoutExpired:
                failed.append(check.name + " (timeout)")
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("Failed: " + ", ".join(failed))
    return int(bool(failed))


if __name__ == "__main__":
    raise SystemExit(main())
