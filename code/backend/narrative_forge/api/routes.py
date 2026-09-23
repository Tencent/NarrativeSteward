"""HTTP 路由：项目 / 素材 / 片段读写 / 对话触发 / SSE 事件流（见 DESIGN §6.9）。

约定：
- 命令与查询走 REST；一切"过程与产物"的实时推送走每项目一条 SSE（``GET .../events``）。
- 手动保存片段经 Pydantic 校验 + ``revision`` 乐观锁（冲突 409）；Agent 回合期间项目只读（423）。
- 端点从 ``request.app.state`` 取运行时单例（store / bus / locks / sessions），见 ``app.py``。
"""

from __future__ import annotations
import asyncio
import base64
import binascii
import json
import logging
import mimetypes
import uuid
from threading import Event
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse
from narrative_forge.agents.prompts import normalize_response_locale
from narrative_forge.api.runtime import (
    AgentTurnRunRegistry,
    EventBus,
    ProjectLocks,
    SessionRegistry,
    ValidationRunRegistry,
)
from narrative_forge.api.schemas import (
    AssetGenerateReq,
    AssetUploadReq,
    ChatReq,
    CreateProjectReq,
    DataPutReq,
    MaterialUploadReq,
)
from narrative_forge.core.playtest_context import (
    format_playtest_note,
    playtest_context_from_mapping,
    resolve_playtest_context,
)
from narrative_forge.core.agent_changeset_service import (
    AgentChangesetConflict,
    AgentChangesetService,
)
from narrative_forge.core.card_image_service import (
    CardImageConfigurationError,
    CardImageGenerationError,
    agenerate_card_image_asset,
)
from narrative_forge.core.models import ProjectMeta
from narrative_forge.core.state_validation_service import (
    StateValidationCancelled,
    StateValidationResourceStop,
    run_state_validation_for_project,
)
from narrative_forge.core.state_variable_usage_service import (
    state_variable_usages_for_project,
)
from narrative_forge.core.speaker_references import collect_world_card_reference_errors
from narrative_forge.core.store import DATA_TYPES, TEXT_TYPES, ProjectStore
from narrative_forge.core.validation import (
    reachability_warnings,
    validate_data,
    validate_project_scalar_contract,
    validate_scene,
)
from narrative_forge.orchestrator.turn_control import (
    AgentTurnStopped,
    TurnStopController,
)
from narrative_forge.orchestrator.turn_workspace import (
    TurnWorkspaceService,
    snapshot_to_bundle,
)

router = APIRouter()
logger = logging.getLogger(__name__)
_ALL_TYPES = (*TEXT_TYPES, *DATA_TYPES)
_TRANSIENT_HINTS = (
    "backend error",
    "invalid_request_error",
    "internal server error",
    "overloaded",
    "rate limit",
    "timeout",
    "timed out",
    "502",
    "503",
    "504",
    "connection",
    "service unavailable",
)


def _friendly_error(exc: Exception) -> str:
    """把回合异常转成面向用户的简短提示（原始细节走日志，不透传给前端）。"""
    raw = str(exc).strip()
    low = raw.lower()
    if any((h in low for h in _TRANSIENT_HINTS)):
        return "生成失败：上游模型服务暂时不可用或繁忙，请稍后重试。"
    first_line = raw.splitlines()[0] if raw else "未知错误"
    return f"生成失败：{first_line[:200]}"


def _store(req: Request) -> ProjectStore:
    return req.app.state.store


def _bus(req: Request) -> EventBus:
    return req.app.state.bus


def _locks(req: Request) -> ProjectLocks:
    return req.app.state.locks


def _sessions(req: Request) -> SessionRegistry:
    return req.app.state.sessions


def _validation_runs(req: Request) -> ValidationRunRegistry:
    """返回正式检测任务注册表。"""
    return req.app.state.validation_runs


def _agent_turn_runs(req: Request) -> AgentTurnRunRegistry:
    """返回 Agent 回合运行注册表。"""
    return req.app.state.agent_turn_runs


def _agent_changesets(req: Request) -> AgentChangesetService:
    """返回 Agent 单回合修改集服务。"""
    return req.app.state.agent_changesets


def _turn_workspaces(req: Request) -> TurnWorkspaceService:
    """返回回合草稿工作区服务。"""
    return req.app.state.turn_workspaces


def _implicitly_keep_pending(request: Request, project_id: str) -> None:
    """在后续写入前把上一轮待检查修改登记为隐式保留。

    摘要控制是非阻塞辅助能力；其持久文件意外损坏时记录诊断，但不能阻断用户
    继续编辑或发起新回合。
    """
    try:
        kept = _agent_changesets(request).resolve_pending_implicitly(project_id)
        if kept is None:
            return
        _bus(request).publish(
            project_id,
            {"type": "agent_changeset_updated", "changeset": kept.model_dump()},
        )
    except Exception:
        logger.exception("隐式保留 Agent 修改集失败 project=%s", project_id)


def _require_project(request: Request, project_id: str) -> ProjectMeta:
    """Load a local project and reject all writes to bundled tutorials."""
    store = _store(request)
    if not store.exists(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"项目不存在: {project_id}")
    if request.app.state.quick_start_demo.is_demo(
        project_id
    ) and request.method not in {"GET", "HEAD", "OPTIONS"}:
        raise HTTPException(status.HTTP_423_LOCKED, "教学样例只读，请新建自己的项目")
    return store.load_meta(project_id)


def _public_meta(meta: ProjectMeta) -> dict:
    """返回前端需要的项目元数据，隐藏仅供旧项目反序列化的依赖基线字段。"""
    return meta.model_dump(exclude={"based_on", "scene_based_on"})


def _project_state(store: ProjectStore, locks: ProjectLocks, meta: ProjectMeta) -> dict:
    """项目概览：公开元数据、检测状态与是否处于 Agent 回合。"""
    return {
        **_public_meta(meta),
        "validation": {
            key: value
            for key, value in store.validation_state(meta.id).items()
            if key != "report"
        },
        "busy": locks.is_busy(meta.id),
    }


def _data_state(store: ProjectStore, meta: ProjectMeta, data_type: str) -> dict:
    """单个片段的状态：内容、revision 与 stage。"""
    if data_type in DATA_TYPES:
        content = store.get_data(meta.id, data_type)
    else:
        content = store.get_text(meta.id, data_type)
    return {
        "data_type": data_type,
        "revision": meta.revisions.get(data_type, 0),
        "stage": meta.stages.get(data_type, "empty"),
        "content": content,
    }


def _event_nodes(store: ProjectStore, project_id: str) -> list[dict]:
    """从 ``events.json`` 取事件节点列表（``[{id,title,type}, …]``）；无事件图时返回空。"""
    events = store.get_data(project_id, "events")
    if not isinstance(events, dict):
        return []
    nodes = events.get("nodes")
    if not isinstance(nodes, list):
        return []
    out: list[dict] = []
    for n in nodes:
        if isinstance(n, dict) and n.get("id"):
            out.append(
                {
                    "id": n["id"],
                    "title": n.get("title", ""),
                    "type": n.get("type", "mainline"),
                }
            )
    return out


def _scene_overview(store: ProjectStore, meta: ProjectMeta) -> list[dict]:
    """场景层总览：对每个事件节点给出其情节图是否已生成及版本。

    以事件图的节点为主索引（情节按事件组织），驱动前端"按事件下钻编辑情节"的列表。
    """
    overview: list[dict] = []
    for node in _event_nodes(store, meta.id):
        eid = node["id"]
        overview.append(
            {
                "event_id": eid,
                "title": node["title"],
                "type": node["type"],
                "has_scene": store.scene_file(meta.id, eid).exists(),
                "revision": meta.scene_revisions.get(eid, 0),
            }
        )
    return overview


def _reachability(store: ProjectStore, project_id: str) -> list[dict]:
    """跨层数值可达性软校验：汇总事件图 + 全部已生成场景图，估各 scalar 阈值可达性。

    只读、无副作用（见 DESIGN §4.2.1）；供前端「事件网络」面板顶部展示 warning 条、
    并在关系图上按 `edge_id` 标红对应边。返回结构化项 `{message, edge_id, var}`。
    """
    validation = store.validation_state(project_id)
    report = validation.get("report") or {}
    if (report.get("meta") or {}).get("propagation_ran") is True:
        return []
    events = store.get_data(project_id, "events")
    scenes = [
        s
        for eid in store.list_scene_event_ids(project_id)
        if isinstance((s := store.get_scene(project_id, eid)), dict)
    ]
    return reachability_warnings(events if isinstance(events, dict) else None, scenes)


def _scene_state(store: ProjectStore, meta: ProjectMeta, event_id: str) -> dict:
    """单个事件情节图的状态：内容、revision 与是否存在。"""
    return {
        "event_id": event_id,
        "revision": meta.scene_revisions.get(event_id, 0),
        "content": store.get_scene(meta.id, event_id),
        "exists": store.scene_file(meta.id, event_id).exists(),
    }


@router.get("/quick-start/demo")
def get_quick_start_demo(request: Request, locale: str = "zh-CN") -> dict:
    """Return the selected locale's bundled tutorial."""
    return request.app.state.quick_start_demo.ensure(locale)


@router.get("/projects")
def list_projects(request: Request) -> dict:
    return {
        "projects": [_public_meta(meta) for meta in _store(request).list_projects()]
    }


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create_project(request: Request, body: CreateProjectReq) -> dict:
    """新建项目。"""
    store, locks = (_store(request), _locks(request))
    meta = store.create_project(body.name)
    return _project_state(store, locks, meta)


@router.get("/projects/{project_id}")
def get_project(request: Request, project_id: str) -> dict:
    """获取单个项目概览（含检测状态与忙状态）。"""
    store, locks = (_store(request), _locks(request))
    meta = _require_project(request, project_id)
    return _project_state(store, locks, meta)


@router.get("/projects/{project_id}/materials")
def list_materials(request: Request, project_id: str) -> dict:
    """列出项目素材库中的素材（文件名 + 大小）。"""
    store = _store(request)
    _require_project(request, project_id)
    return {"materials": store.list_materials(project_id)}


@router.get("/projects/{project_id}/materials/{filename}")
def preview_material(
    request: Request,
    project_id: str,
    filename: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100000, ge=1, le=200000),
) -> dict:
    """按字符分段读取一份纯文本素材，供只读预览使用。"""
    store = _store(request)
    _require_project(request, project_id)
    try:
        return store.get_material_chunk(
            project_id, filename, offset=offset, limit=limit
        )
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "素材不存在") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@router.post("/projects/{project_id}/materials", status_code=status.HTTP_201_CREATED)
def upload_material(request: Request, project_id: str, body: MaterialUploadReq) -> dict:
    """上传一份素材（同名覆盖；仅 .md/.txt/.json；Agent 回合期间拒绝）。"""
    store, locks = (_store(request), _locks(request))
    _require_project(request, project_id)
    if locks.is_busy(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    try:
        name = store.add_material(project_id, body.filename, body.content)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    return {"ok": True, "name": name, "materials": store.list_materials(project_id)}


@router.delete("/projects/{project_id}/materials/{filename}")
def delete_material(request: Request, project_id: str, filename: str) -> dict:
    """删除一份素材（Agent 回合期间拒绝）。"""
    store, locks = (_store(request), _locks(request))
    _require_project(request, project_id)
    if locks.is_busy(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    try:
        store.delete_material(project_id, filename)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    return {"ok": True, "materials": store.list_materials(project_id)}


def _decode_b64_image(data_b64: str) -> bytes:
    """把 base64（或 ``data:`` URL）解码为图片字节；非法则抛 422。"""
    raw = data_b64.split(",", 1)[1] if data_b64.startswith("data:") else data_b64
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "图片数据非法（base64 解码失败）"
        )


@router.post("/projects/{project_id}/assets", status_code=status.HTTP_201_CREATED)
async def upload_asset(request: Request, project_id: str, body: AssetUploadReq) -> dict:
    """上传一张配图（角色/地点卡片；png/jpg/jpeg/webp/gif，≤5MB）。

    仅落盘并返回文件名；把 ``assets/<name>`` 写进卡片 ``image`` 由前端在 world 保存时完成。
    全程持有项目锁，避免与 Agent 或其它写入交错。
    """
    store, locks = (_store(request), _locks(request))
    _require_project(request, project_id)
    if not await locks.acquire(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    try:
        data = _decode_b64_image(body.data_b64)
        try:
            name = store.add_asset(project_id, body.filename, data)
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
        return {"ok": True, "name": name, "path": f"assets/{name}"}
    finally:
        await locks.release(project_id)


@router.post(
    "/projects/{project_id}/assets/generate", status_code=status.HTTP_201_CREATED
)
async def generate_asset(
    request: Request, project_id: str, body: AssetGenerateReq
) -> dict:
    """按角色/地点卡片草稿生成配图。

    本端点与手动上传保持相同语义：只生成项目资产并返回 ``assets/<name>``，不直接修改
    ``world.json``。前端把路径写进当前草稿，用户统一点击“保存”后再登记 world revision。
    全程持有项目锁，并走异步生图以免堵住事件循环。
    """
    store, locks = (_store(request), _locks(request))
    _require_project(request, project_id)
    if not await locks.acquire(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    try:
        generated = await agenerate_card_image_asset(
            store,
            project_id,
            category=body.category,
            name=body.name,
            description=body.description,
            tags=body.tags,
            visual_instructions=body.visual_instructions,
        )
        return {
            "ok": True,
            "name": generated.name,
            "path": generated.path,
            "model": generated.model,
            "size": generated.size,
            "background": generated.background,
        }
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except CardImageConfigurationError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except CardImageGenerationError as exc:
        logger.exception("项目 %s 面板生图失败", project_id)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await locks.release(project_id)


@router.get("/projects/{project_id}/assets/{filename}")
def get_asset(request: Request, project_id: str, filename: str) -> FileResponse:
    """读取一张配图（供前端 ``<img>`` 直接引用）；不存在回 404。"""
    store = _store(request)
    _require_project(request, project_id)
    path = store.asset_path(project_id, filename)
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "配图不存在")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@router.get("/projects/{project_id}/data/{data_type}")
def get_data(request: Request, project_id: str, data_type: str) -> dict:
    """读取某片段内容与状态。"""
    store = _store(request)
    if data_type not in _ALL_TYPES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"未知片段类型: {data_type}")
    meta = _require_project(request, project_id)
    return _data_state(store, meta, data_type)


@router.put("/projects/{project_id}/data/{data_type}")
def put_data(
    request: Request, project_id: str, data_type: str, body: DataPutReq
) -> dict:
    """手动保存某片段：校验 + revision 乐观锁 + 版本登记 + 广播领域事件。

    - JSON 片段（world/events）：``content`` 须为对象且通过校验（events 含图结构校验），否则 422。
    - 自由文本片段（intent/outline）：``content`` 须为字符串。
    - ``base_revision`` 与服务端当前不一致 → 409；Agent 回合期间 → 423。
    """
    store, locks, bus = (_store(request), _locks(request), _bus(request))
    if data_type not in _ALL_TYPES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"未知片段类型: {data_type}")
    meta = _require_project(request, project_id)
    if locks.is_busy(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    current = meta.revisions.get(data_type, 0)
    if body.base_revision is not None and body.base_revision != current:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"版本冲突：你基于 r{body.base_revision} 编辑，但当前已是 r{current}，请刷新后重试。",
        )
    if data_type in DATA_TYPES:
        if not isinstance(body.content, dict):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "该片段须为 JSON 对象"
            )
        content = body.content
        ok, msg = validate_data(data_type, content)
        if not ok:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"未通过校验：{msg}"
            )
        if data_type == "events":
            project_scenes = [
                scene
                for scene_id in store.list_scene_event_ids(project_id)
                if isinstance((scene := store.get_scene(project_id, scene_id)), dict)
            ]
            ok, msg = validate_project_scalar_contract(content, project_scenes)
            if not ok:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY, f"未通过 scalar 校验：{msg}"
                )
        if data_type == "world":
            project_scenes = [
                scene
                for scene_id in store.list_scene_event_ids(project_id)
                if isinstance((scene := store.get_scene(project_id, scene_id)), dict)
            ]
            ref_errors = collect_world_card_reference_errors(content, project_scenes)
            if ref_errors:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "未通过校验：\n" + "\n".join((f"- {item}" for item in ref_errors)),
                )
        store.set_data(project_id, data_type, content)
    else:
        if not isinstance(body.content, str):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "该片段须为字符串"
            )
        store.set_text(project_id, data_type, body.content)
    rev = store.bump_revision(project_id, data_type)
    _implicitly_keep_pending(request, project_id)
    bus.publish(
        project_id,
        {
            "type": "data_updated",
            "data_type": data_type,
            "revision": rev,
            "source": "manual",
        },
    )
    state = _data_state(store, store.load_meta(project_id), data_type)
    return state


@router.get("/projects/{project_id}/state-variable-usages")
def get_state_variable_usages(request: Request, project_id: str) -> dict:
    """返回当前事件与全部情节中的状态变量写入/读取定位索引。"""
    store = _store(request)
    _require_project(request, project_id)
    return {"variables": state_variable_usages_for_project(store, project_id)}


@router.get("/projects/{project_id}/scenes")
def list_scenes(request: Request, project_id: str) -> dict:
    """场景总览：以事件节点为索引，列出每个事件的情节图是否已生成及版本。"""
    store = _store(request)
    meta = _require_project(request, project_id)
    return {"scenes": _scene_overview(store, meta)}


@router.get("/projects/{project_id}/scenes/{event_id}")
def get_scene(request: Request, project_id: str, event_id: str) -> dict:
    """读取某事件的情节图内容与状态。"""
    store = _store(request)
    meta = _require_project(request, project_id)
    try:
        store._safe_event_id(event_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"非法事件 id: {event_id}")
    return _scene_state(store, meta, event_id)


@router.put("/projects/{project_id}/scenes/{event_id}")
def put_scene(
    request: Request, project_id: str, event_id: str, body: DataPutReq
) -> dict:
    """手动保存某事件的情节图：校验（结构 + effect/condition 引用）+ revision 乐观锁 + 版本登记 + 广播。

    - ``content`` 须为对象且通过场景图校验（effect/condition 引用事件层已声明变量）。
    - ``base_revision`` 与服务端该事件情节图当前 revision 不一致 → 409；Agent 回合期间 → 423。
    """
    store, locks, bus = (_store(request), _locks(request), _bus(request))
    meta = _require_project(request, project_id)
    try:
        store._safe_event_id(event_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"非法事件 id: {event_id}")
    if locks.is_busy(project_id):
        raise HTTPException(status.HTTP_423_LOCKED, "项目正在生成中，暂不可编辑")
    current = meta.scene_revisions.get(event_id, 0)
    if body.base_revision is not None and body.base_revision != current:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"版本冲突：你基于 r{body.base_revision} 编辑，但当前已是 r{current}，请刷新后重试。",
        )
    if not isinstance(body.content, dict):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "该片段须为 JSON 对象"
        )
    events = store.get_data(project_id, "events") or {}
    state_vars = events.get("state_variables", []) if isinstance(events, dict) else []
    world = store.get_data(project_id, "world") or {}
    world_locs = world.get("locations", []) if isinstance(world, dict) else []
    event_ids = (
        {
            node.get("id")
            for node in events.get("nodes", [])
            if isinstance(node, dict) and node.get("id")
        }
        if isinstance(events, dict)
        else set()
    )
    if event_id not in event_ids:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"事件图中不存在事件 {event_id}，不能保存其情节",
        )
    content = body.content
    ok, msg = validate_scene(
        content,
        state_vars,
        world_locs,
        expected_event_id=event_id,
        world_data=world if isinstance(world, dict) else {},
    )
    if not ok:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"未通过校验：{msg}")
    project_scenes = [
        content if scene_id == event_id else store.get_scene(project_id, scene_id)
        for scene_id in sorted({*store.list_scene_event_ids(project_id), event_id})
    ]
    ok, msg = validate_project_scalar_contract(
        events, [scene for scene in project_scenes if isinstance(scene, dict)]
    )
    if not ok:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"未通过 scalar 校验：{msg}"
        )
    store.set_scene(project_id, event_id, content)
    rev = store.bump_scene_revision(project_id, event_id)
    _implicitly_keep_pending(request, project_id)
    bus.publish(
        project_id,
        {
            "type": "data_updated",
            "data_type": "scenes",
            "event_id": event_id,
            "revision": rev,
            "source": "manual",
        },
    )
    state = _scene_state(store, store.load_meta(project_id), event_id)
    return state


@router.get("/projects/{project_id}/reachability")
def get_reachability(request: Request, project_id: str) -> dict:
    """跨层数值可达性软校验结果：列出"再乐观也够不到"的 scalar 事件边阈值（warning 级）。

    非阻塞诊断（见 DESIGN §4.2.1）：`warnings` 为空表示未发现不可达阈值。
    """
    store = _store(request)
    _require_project(request, project_id)
    return {"warnings": _reachability(store, project_id)}


@router.get("/projects/{project_id}/validation")
def get_validation(request: Request, project_id: str) -> dict:
    """返回当前版本的检测状态，不自动运行检测。"""
    store = _store(request)
    _require_project(request, project_id)
    return store.validation_state(project_id)


@router.post("/projects/{project_id}/validation/run")
async def run_validation(request: Request, project_id: str) -> dict:
    """把项目置为只读并在后台启动正式联合状态检测。"""
    store = _store(request)
    locks = _locks(request)
    runs = _validation_runs(request)
    _require_project(request, project_id)
    if not await locks.acquire(project_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "项目已有进行中的生成或检测任务，请稍候"
        )
    run = runs.begin(project_id)
    if run is None:
        await locks.release(project_id)
        raise HTTPException(
            status.HTTP_409_CONFLICT, "该项目已有完整检测正在运行，请稍候"
        )
    task = asyncio.create_task(
        _run_state_validation_task(
            store, _bus(request), locks, runs, project_id, run.run_id, run.cancel_event
        )
    )
    tasks: set = request.app.state.tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return run.public()


@router.get("/projects/{project_id}/validation/run")
def get_validation_run(request: Request, project_id: str) -> dict:
    """返回当前或最近一次正式检测的运行状态与进度。"""
    _require_project(request, project_id)
    return _validation_runs(request).get(project_id)


@router.post("/projects/{project_id}/validation/cancel")
def cancel_validation(request: Request, project_id: str) -> dict:
    """请求取消当前正式检测；实际释放只读锁由后台任务 ``finally`` 完成。"""
    _require_project(request, project_id)
    run = _validation_runs(request).request_cancel(project_id)
    if run is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前没有可取消的完整检测")
    return run


async def _run_state_validation_task(
    store: ProjectStore,
    bus: EventBus,
    locks: ProjectLocks,
    runs: ValidationRunRegistry,
    project_id: str,
    run_id: str,
    cancel_event: Event,
) -> None:
    """在线程中执行 CPU 密集检测，并保证所有退出路径释放项目只读锁。"""
    try:
        result = await asyncio.to_thread(
            run_state_validation_for_project,
            store,
            project_id,
            cancel_event=cancel_event,
            progress_callback=lambda progress: runs.update_progress(
                project_id, run_id, progress
            ),
        )
        runs.finish(
            project_id, run_id, status="completed", result_status=result["status"]
        )
        bus.publish(
            project_id,
            {
                "type": "validation_updated",
                "status": result["status"],
                "fingerprint": result["current_fingerprint"],
            },
        )
    except StateValidationCancelled:
        runs.finish(project_id, run_id, status="cancelled")
    except StateValidationResourceStop as exc:
        runs.finish(project_id, run_id, status="error", error=str(exc))
    except Exception:
        logger.exception("正式联合状态检测失败 project_id=%s", project_id)
        runs.finish(
            project_id, run_id, status="error", error="检测内部错误，本次未保存新结论"
        )
    finally:
        await locks.release(project_id)
        bus.publish(
            project_id, {"type": "validation_run_updated", **runs.get(project_id)}
        )


@router.get("/projects/{project_id}/agent-changesets/latest")
def latest_agent_changeset(request: Request, project_id: str) -> dict:
    """返回最近 Agent 修改集，供刷新后恢复摘要状态。"""
    _require_project(request, project_id)
    changeset = _agent_changesets(request).latest(project_id)
    return {"changeset": changeset.model_dump() if changeset else None}


@router.post("/projects/{project_id}/agent-changesets/{changeset_id}/keep")
def keep_agent_changeset(request: Request, project_id: str, changeset_id: str) -> dict:
    """明确保留一轮 Agent 修改。"""
    _require_project(request, project_id)
    try:
        changeset = _agent_changesets(request).keep(project_id, changeset_id)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent 修改集不存在") from exc
    except AgentChangesetConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    _bus(request).publish(
        project_id,
        {"type": "agent_changeset_updated", "changeset": changeset.model_dump()},
    )
    return {"changeset": changeset.model_dump()}


@router.post("/projects/{project_id}/agent-changesets/{changeset_id}/revert")
async def revert_agent_changeset(
    request: Request, project_id: str, changeset_id: str
) -> dict:
    """冲突安全地撤销最近完整 Agent 回合，并广播恢复后的 revision。"""
    _require_project(request, project_id)
    locks = _locks(request)
    if not await locks.acquire(project_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "项目正在执行其它任务，暂不能撤销"
        )
    try:
        changeset = _agent_changesets(request).revert(project_id, changeset_id)
        for fragment in changeset.fragments:
            revision = changeset.reverted_revisions.get(fragment.key)
            if fragment.data_type == "scene":
                _bus(request).publish(
                    project_id,
                    {
                        "type": "data_updated",
                        "data_type": "scenes",
                        "event_id": fragment.event_id,
                        "revision": revision,
                        "source": "agent_revert",
                    },
                )
            else:
                _bus(request).publish(
                    project_id,
                    {
                        "type": "data_updated",
                        "data_type": fragment.data_type,
                        "revision": revision,
                        "source": "agent_revert",
                    },
                )
        _bus(request).publish(
            project_id,
            {"type": "agent_changeset_updated", "changeset": changeset.model_dump()},
        )
        return {"changeset": changeset.model_dump()}
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent 修改集不存在") from exc
    except AgentChangesetConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    finally:
        await locks.release(project_id)


@router.post("/projects/{project_id}/chat", status_code=status.HTTP_202_ACCEPTED)
async def chat(request: Request, project_id: str, body: ChatReq) -> dict:
    """触发一个 Agent 对话回合：立即返回，token/状态/完成事件经该项目 SSE 推送。"""
    store, locks, sessions, bus = (
        _store(request),
        _locks(request),
        _sessions(request),
        _bus(request),
    )
    _require_project(request, project_id)
    if not await locks.acquire(project_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "项目已有进行中的生成回合，请稍候"
        )
    session = sessions.get(project_id)
    response_locale = normalize_response_locale(body.locale)
    if hasattr(session, "set_response_locale"):
        session.set_response_locale(response_locale)
    changesets = _agent_changesets(request)
    turn_id = uuid.uuid4().hex
    stop_controller = TurnStopController(turn_id)
    turn_runs = _agent_turn_runs(request)
    workspaces = _turn_workspaces(request)
    try:
        _implicitly_keep_pending(request, project_id)
        changeset_baseline = changesets.capture_baseline(project_id)
        started = turn_runs.begin(project_id, turn_id, stop_controller)
        if started is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "项目已有进行中的生成回合，请稍候"
            )
        workspaces.begin(project_id, turn_id)
    except Exception:
        workspace = workspaces.get(project_id, turn_id)
        if workspace is not None:
            workspaces.abort(workspace)
        await locks.release(project_id)
        raise
    playtest_note = None
    if body.playtest_context is not None:
        playtest_note = format_playtest_note(
            resolve_playtest_context(
                store, project_id, playtest_context_from_mapping(body.playtest_context)
            )
        )
    task = asyncio.create_task(
        _run_turn(
            store,
            bus,
            locks,
            session,
            project_id,
            body.message,
            turn_id,
            changesets,
            changeset_baseline,
            turn_runs,
            stop_controller,
            workspaces,
            playtest_note,
        )
    )
    tasks: set = request.app.state.tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"status": "started", "turn_id": turn_id}


@router.get("/projects/{project_id}/chat/run")
def get_chat_run(request: Request, project_id: str) -> dict:
    """返回当前或最近一次 Agent 回合状态，供刷新或 SSE 重连校准前端相位。"""
    _require_project(request, project_id)
    return _agent_turn_runs(request).get(project_id)


@router.get("/projects/{project_id}/chat/preview/{turn_id}/{generation}")
def get_turn_preview(
    request: Request, project_id: str, turn_id: str, generation: int
) -> dict:
    """返回某检查点的不可变预览 bundle；正式 GET 不会隐式带出这些内容。"""
    _require_project(request, project_id)
    workspaces = _turn_workspaces(request)
    workspace = workspaces.get(project_id, turn_id)
    if workspace is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "预览代次不存在")
    snapshot = workspace.previews.get(generation)
    if snapshot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "预览代次不存在")
    if snapshot.revoked:
        raise HTTPException(status.HTTP_409_CONFLICT, "预览代次已撤销")
    live = workspaces.get_preview(project_id, turn_id, generation)
    if live is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "预览代次已撤销")
    return snapshot_to_bundle(live, turn_id=turn_id)


@router.get(
    "/projects/{project_id}/chat/preview/{turn_id}/{generation}/assets/{filename}"
)
def get_turn_preview_asset(
    request: Request, project_id: str, turn_id: str, generation: int, filename: str
) -> FileResponse:
    """读取某一代冻结的预览配图；未知 404，已撤销 409。"""
    _require_project(request, project_id)
    workspaces = _turn_workspaces(request)
    workspace = workspaces.get(project_id, turn_id)
    if workspace is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "预览代次不存在")
    snapshot = workspace.previews.get(generation)
    if snapshot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "预览代次不存在")
    if snapshot.revoked:
        raise HTTPException(status.HTTP_409_CONFLICT, "预览代次已撤销")
    path = workspaces.preview_asset_path(project_id, turn_id, generation, filename)
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "预览配图不存在")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


@router.post("/projects/{project_id}/chat/stop")
def stop_chat(request: Request, project_id: str) -> dict:
    """请求停止并撤销本轮。只登记停止，不释放项目锁。"""
    _require_project(request, project_id)
    outcome, payload = _agent_turn_runs(request).request_stop(project_id)
    if outcome == "idle":
        raise HTTPException(status.HTTP_409_CONFLICT, "当前没有正在生成的 Agent 回合")
    if outcome == "completing":
        raise HTTPException(status.HTTP_409_CONFLICT, "回合已完成或正在完成")
    if payload is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "当前没有正在生成的 Agent 回合")
    if outcome == "accepted":
        _bus(request).publish(
            project_id,
            {
                "type": "turn_stop_requested",
                "turn_id": payload.get("turn_id"),
                "stop_requested_at": payload.get("stop_requested_at"),
            },
        )
    return {"status": "stop_requested", **payload}


@router.get("/projects/{project_id}/history")
def get_history(request: Request, project_id: str) -> dict:
    """读取项目的对话历史（持久化 transcript，供前端重进项目时还原对话）。"""
    store = _store(request)
    _require_project(request, project_id)
    messages = store.get_chat(project_id)
    for message in messages:
        embedded = message.get("changeset")
        changeset_id = embedded.get("id") if isinstance(embedded, dict) else None
        if not changeset_id:
            continue
        try:
            message["changeset"] = (
                _agent_changesets(request).load(project_id, changeset_id).model_dump()
            )
        except FileNotFoundError:
            message["changeset"] = None
    return {"messages": messages}


@router.get("/projects/{project_id}/events")
async def events(request: Request, project_id: str) -> EventSourceResponse:
    """该项目的 SSE 事件流：领域事件（data_updated）+ 任务进度（turn_*/token/status/error）。"""
    bus = _bus(request)
    _require_project(request, project_id)
    return EventSourceResponse(_event_gen(request, bus, project_id))


async def _event_gen(request: Request, bus: EventBus, project_id: str):
    """从事件总线拉取事件并以 SSE 形式产出；客户端断开时退订。"""
    queue = bus.subscribe(project_id)
    try:
        yield {"event": "ready", "data": json.dumps({"type": "ready"})}
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                continue
            yield {
                "event": event.get("type", "message"),
                "data": json.dumps(event, ensure_ascii=False),
            }
    finally:
        bus.unsubscribe(project_id, queue)


def _revoke_turn_previews(
    bus: EventBus,
    project_id: str,
    turn_id: str,
    workspaces: TurnWorkspaceService | None,
    reason: str,
) -> None:
    """撤销本轮预览代次并广播 ``preview_revoked``。"""
    if workspaces is None:
        return
    workspace = workspaces.get(project_id, turn_id)
    if workspace is None:
        return
    if workspace.phase == "committed":
        revoked = workspaces.revoke_previews(workspace, reason)
    else:
        revoked = workspaces.abort(workspace)
    for generation in revoked:
        bus.publish(
            project_id,
            {
                "type": "preview_revoked",
                "turn_id": turn_id,
                "generation": generation,
                "reason": reason,
            },
        )


def _broadcast_failed_turn_restore(
    store: ProjectStore,
    bus: EventBus,
    project_id: str,
    restored_keys: list[str],
    *,
    restored_validation: bool,
) -> None:
    """失败回合回滚后通知前端重新读取已恢复的片段和检测状态。"""
    meta = store.load_meta(project_id)
    for key in restored_keys:
        if key.startswith("scene:"):
            event_id = key.split(":", 1)[1]
            bus.publish(
                project_id,
                {
                    "type": "data_updated",
                    "data_type": "scenes",
                    "event_id": event_id,
                    "revision": meta.scene_revisions.get(event_id, 0),
                    "source": "agent_rollback",
                },
            )
            continue
        if key.startswith("asset:"):
            continue
        bus.publish(
            project_id,
            {
                "type": "data_updated",
                "data_type": key,
                "revision": meta.revisions.get(key, 0),
                "source": "agent_rollback",
            },
        )
    if restored_keys or restored_validation:
        validation = store.validation_state(project_id)
        bus.publish(
            project_id,
            {
                "type": "validation_updated",
                "status": validation["status"],
                "fingerprint": validation["current_fingerprint"],
            },
        )


def _history_step(data: dict, *, done: bool) -> dict:
    """聊天历史只保留步骤元信息，不复制大型工具输入/输出。"""
    return {
        "step_id": data.get("step_id"),
        "parent_step_id": data.get("parent_step_id"),
        "tool": data.get("tool"),
        "agent": data.get("agent"),
        "subagent": data.get("subagent"),
        "label": data.get("label"),
        "done_label": data.get("done_label"),
        "done": done,
    }


def _should_broadcast_process_event(event_type: str, data: dict) -> bool:
    """过程事件是否进入 SSE。明确标为 Agent 专用的 status 只留在模型上下文。"""
    if event_type == "status" and data.get("audience") == "agent":
        return False
    return True


async def _run_turn(
    store: ProjectStore,
    bus: EventBus,
    locks: ProjectLocks,
    session,
    project_id: str,
    message: str,
    turn_id: str = "",
    changesets: AgentChangesetService | None = None,
    changeset_baseline: dict[str, dict] | None = None,
    turn_runs: AgentTurnRunRegistry | None = None,
    stop_controller: TurnStopController | None = None,
    workspaces: TurnWorkspaceService | None = None,
    playtest_note: str | None = None,
) -> None:
    """后台执行一个流式回合：广播过程事件到 SSE、把对话落盘、结束后释放编辑锁。

    持久化策略（见 DESIGN §6.9）：开头写入用户消息，回合完成时写入助手最终回复
    （含本轮工具/子 Agent 步骤）；用户停止或出错则按回合前基线整轮回滚。
    用户停止写入停止后的助手记录，技术失败写入 system 错误消息。
    """
    turn_id = turn_id or uuid.uuid4().hex
    bus.publish(project_id, {"type": "turn_start", "turn_id": turn_id})
    store.append_chat(project_id, {"role": "user", "text": message})
    steps: list[dict] = []
    rolled_back = False
    restored_keys: list[str] = []
    finish_status = "failed"
    try:
        async for ev in session.astream_turn(
            message,
            stop_controller=stop_controller,
            turn_id=turn_id,
            workspace=None
            if workspaces is None
            else workspaces.get(project_id, turn_id),
            playtest_note=playtest_note,
        ):
            if ev.type == "tool_start":
                steps.append(_history_step(ev.data, done=False))
            elif ev.type == "tool_end":
                step_id = ev.data.get("step_id")
                for step in reversed(steps):
                    id_matches = step_id is not None and step.get("step_id") == step_id
                    legacy_matches = (
                        step_id is None
                        and (not step.get("done"))
                        and (step.get("tool") == ev.data.get("tool"))
                    )
                    if id_matches or legacy_matches:
                        step["done"] = True
                        if ev.data.get("error"):
                            step["error"] = ev.data.get("error")
                        if ev.data.get("duration_ms") is not None:
                            step["duration_ms"] = ev.data.get("duration_ms")
                        break
            if ev.type == "tool_end" and ev.data.get("tool") == "run_state_validation":
                workspace = (
                    workspaces.get(project_id, turn_id)
                    if workspaces is not None
                    else None
                )
                validation_store = (
                    workspace.draft_store if workspace is not None else store
                )
                validation = validation_store.validation_state(project_id)
            if ev.type == "completed":
                if turn_runs is not None and (
                    not turn_runs.mark_completing(project_id, turn_id)
                ):
                    raise AgentTurnStopped()
                failed = ev.data.get("failed") or {}
                committed = ev.data.get("committed", True) and (
                    not ev.data.get("aborted")
                )
                if (
                    committed
                    and ev.data.get("budget_closed")
                    and failed
                    and (changesets is not None)
                    and (changeset_baseline is not None)
                ):
                    try:
                        changesets.restore_keys(
                            project_id, changeset_baseline, list(failed)
                        )
                    except Exception:
                        logger.exception(
                            "预算收口后恢复非法片段失败 project=%s turn=%s",
                            project_id,
                            turn_id,
                        )
                for dt, rev in ev.data.get("updated", []) if committed else []:
                    event_id = (
                        dt.split(":", 1)[1]
                        if isinstance(dt, str) and dt.startswith("scene:")
                        else None
                    )
                    deleted = False
                    if isinstance(dt, str) and dt.startswith("scene:"):
                        deleted = not store.scene_file(project_id, event_id).exists()
                    if isinstance(dt, str) and dt.startswith("scene:"):
                        bus.publish(
                            project_id,
                            {
                                "type": "data_updated",
                                "data_type": "scenes",
                                "event_id": dt.split(":", 1)[1],
                                "revision": rev,
                                "source": "agent",
                                "turn_id": turn_id,
                                "deleted": deleted,
                            },
                        )
                    else:
                        bus.publish(
                            project_id,
                            {
                                "type": "data_updated",
                                "data_type": dt,
                                "revision": rev,
                                "source": "agent",
                                "turn_id": turn_id,
                            },
                        )
                if committed and workspaces is not None:
                    live_workspace = workspaces.get(project_id, turn_id)
                    if (
                        live_workspace is not None
                        and live_workspace.validation_promoted
                    ):
                        validation = store.validation_state(project_id)
                        bus.publish(
                            project_id,
                            {
                                "type": "validation_updated",
                                "status": validation["status"],
                                "fingerprint": validation["current_fingerprint"],
                                "turn_id": turn_id,
                                "source": "agent_commit",
                            },
                        )
                changeset = None
                if (
                    committed
                    and changesets is not None
                    and (changeset_baseline is not None)
                ):
                    try:
                        changeset = changesets.complete(
                            project_id, turn_id, changeset_baseline
                        )
                    except Exception:
                        logger.exception(
                            "Agent 修改摘要生成失败 project=%s turn=%s",
                            project_id,
                            turn_id,
                        )
                        bus.publish(
                            project_id,
                            {
                                "type": "status",
                                "text": "本轮内容已更新，但修改摘要生成失败；请先人工检查后再继续。",
                                "audience": "user",
                                "code": "changeset_failed",
                            },
                        )
                changeset_payload = changeset.model_dump() if changeset else None
                store.append_chat(
                    project_id,
                    {
                        "role": "assistant",
                        "text": ev.data.get("text", ""),
                        "steps": [{**step, "done": True} for step in steps],
                        "changeset": changeset_payload,
                        "partial": bool(ev.data.get("partial")),
                        "budget_closed": bool(ev.data.get("budget_closed")),
                        "completed_parts": ev.data.get("completed_parts") or [],
                        "remaining_parts": ev.data.get("remaining_parts") or [],
                    },
                )
                _revoke_turn_previews(
                    bus,
                    project_id,
                    turn_id,
                    workspaces,
                    "committed" if committed else "aborted",
                )
                bus.publish(
                    project_id,
                    {
                        "type": "turn_completed",
                        **ev.data,
                        "changeset": changeset_payload,
                    },
                )
                finish_status = "completed" if committed else "failed"
            else:
                payload = {"type": ev.type, **ev.data}
                payload.setdefault("turn_id", turn_id)
                if not _should_broadcast_process_event(ev.type, payload):
                    continue
                bus.publish(project_id, payload)
    except AgentTurnStopped:
        finish_status = "stopped"
        stopped_text = "已停止，本轮修改均未保留"
        rollback_failed = False
        _revoke_turn_previews(bus, project_id, turn_id, workspaces, "stopped")
        if changesets is not None and changeset_baseline is not None:
            try:
                rollback = changesets.restore_to_baseline(
                    project_id, changeset_baseline
                )
                rolled_back = True
                restored_keys = list(rollback.get("restored_keys") or [])
                _broadcast_failed_turn_restore(
                    store,
                    bus,
                    project_id,
                    restored_keys,
                    restored_validation=bool(rollback.get("restored_validation")),
                )
            except Exception:
                rollback_failed = True
                logger.exception(
                    "用户停止后回滚失败 project=%s turn=%s", project_id, turn_id
                )
                stopped_text = "停止请求已执行，但恢复回合前内容失败，项目可能留下修改，请暂停继续操作并检查"
        else:
            rolled_back = True
        closed_steps = [
            {**step, "done": True, "outcome": "rolled_back"} for step in steps
        ]
        store.append_chat(
            project_id,
            {
                "role": "assistant",
                "text": stopped_text,
                "stopped": True,
                "rolled_back": rolled_back and (not rollback_failed),
                "rollback_failed": rollback_failed,
                "steps": closed_steps,
                "changeset": None,
            },
        )
        bus.publish(
            project_id,
            {
                "type": "turn_stopped",
                "turn_id": turn_id,
                "text": stopped_text,
                "rolled_back": rolled_back and (not rollback_failed),
                "rollback_failed": rollback_failed,
                "steps": closed_steps,
            },
        )
    except asyncio.CancelledError:
        finish_status = "failed"
        logger.exception("对话回合被框架取消 project=%s turn=%s", project_id, turn_id)
        _revoke_turn_previews(bus, project_id, turn_id, workspaces, "cancelled")
        if changesets is not None and changeset_baseline is not None:
            try:
                rollback = changesets.restore_to_baseline(
                    project_id, changeset_baseline
                )
                rolled_back = True
                restored_keys = list(rollback.get("restored_keys") or [])
                _broadcast_failed_turn_restore(
                    store,
                    bus,
                    project_id,
                    restored_keys,
                    restored_validation=bool(rollback.get("restored_validation")),
                )
            except Exception:
                logger.exception(
                    "取消路径回滚失败 project=%s turn=%s", project_id, turn_id
                )
        raise
    except Exception as exc:
        logger.exception("对话回合失败 project=%s", project_id)
        finish_status = "failed"
        friendly = _friendly_error(exc)
        _revoke_turn_previews(bus, project_id, turn_id, workspaces, "error")
        if changesets is not None and changeset_baseline is not None:
            try:
                rollback = changesets.restore_to_baseline(
                    project_id, changeset_baseline
                )
                rolled_back = True
                restored_keys = list(rollback.get("restored_keys") or [])
                _broadcast_failed_turn_restore(
                    store,
                    bus,
                    project_id,
                    restored_keys,
                    restored_validation=bool(rollback.get("restored_validation")),
                )
                friendly = f"{friendly} 未保留任何修改。"
            except Exception:
                logger.exception(
                    "失败回合回滚失败 project=%s turn=%s", project_id, turn_id
                )
                friendly = f"{friendly} 本轮可能留下未完成的修改，请检查后再继续。"
        store.append_chat(project_id, {"role": "system", "text": friendly})
        bus.publish(
            project_id, {"type": "error", "message": friendly, "turn_id": turn_id}
        )
    finally:
        if turn_runs is not None:
            turn_runs.finish(project_id, turn_id, finish_status)
        if workspaces is not None:
            workspaces.drop_turn(project_id, turn_id)
        await locks.release(project_id)
        bus.publish(project_id, {"type": "turn_end", "turn_id": turn_id})
