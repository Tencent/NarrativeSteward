"""以 ``python -m narrative_forge.api`` 启动开发服务器。

环境变量：
- ``NF_API_HOST``（默认 ``127.0.0.1``）
- ``NF_API_PORT``（默认 ``8000``）
"""

from __future__ import annotations

import os

import uvicorn


def _require_single_worker() -> None:
    """拒绝多 worker。EventBus、项目锁、运行注册表和预览注册表都是进程内状态。"""
    for name in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "NF_API_WORKERS"):
        raw = os.environ.get(name)
        if raw is None or not str(raw).strip():
            continue
        if str(raw).strip() != "1":
            raise SystemExit(
                "当前 EventBus、项目锁、运行注册表和预览注册表都是进程内状态，"
                f"必须单 worker 部署。{name}={raw!r} 不受支持。"
                "请使用 python -m narrative_forge.api，并把上述变量设为 1。"
            )


def main() -> None:
    """启动 uvicorn 开发服务器（固定单 worker）。"""
    _require_single_worker()
    host = os.environ.get("NF_API_HOST", "127.0.0.1")
    port = int(os.environ.get("NF_API_PORT", "8000"))
    uvicorn.run(
        "narrative_forge.api.app:app",
        host=host,
        port=port,
        reload=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
