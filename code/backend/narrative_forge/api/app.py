"""Local authoring API; one worker owns sessions, locks and streamed events."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from narrative_forge import config
from narrative_forge.api.routes import router
from narrative_forge.api.runtime import (
    AgentTurnRunRegistry,
    EventBus,
    ProjectLocks,
    SessionRegistry,
    ValidationRunRegistry,
)
from narrative_forge.core.agent_changeset_service import AgentChangesetService
from narrative_forge.core.quick_start_demo import QuickStartDemoService
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.turn_workspace import TurnWorkspaceService


def create_app() -> FastAPI:
    app = FastAPI(title="NarrativeSteward API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    store = ProjectStore(config.get_workspace())
    app.state.store = store
    app.state.turn_workspaces = TurnWorkspaceService(store)
    app.state.turn_workspaces.cleanup_orphans()
    app.state.agent_changesets = AgentChangesetService(store)
    app.state.quick_start_demo = QuickStartDemoService(store)
    app.state.bus = EventBus()
    app.state.locks = ProjectLocks()
    app.state.sessions = SessionRegistry(store)
    app.state.validation_runs = ValidationRunRegistry()
    app.state.agent_turn_runs = AgentTurnRunRegistry()
    app.state.tasks = set()
    app.include_router(router, prefix="/api")

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
