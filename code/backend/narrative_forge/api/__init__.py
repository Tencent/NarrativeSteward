"""API 层：FastAPI REST + SSE，把无头核心 + 编排层包装为可供前端调用的服务（见 DESIGN §6.9）。"""

from narrative_forge.api.app import create_app

__all__ = ["create_app"]
