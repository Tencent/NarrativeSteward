"""API 自测：REST + 乐观锁 + 编辑锁（离线，无 LLM）；可选 --live 验证对话 + SSE 流。

离线部分用 FastAPI ``TestClient`` 跑确定性断言（建项目→素材→片段读写→409/423），
不花 LLM。``--live`` 部分用 httpx ASGI 客户端真正触发一个 intent 对话回合，并从 SSE 流接收
``token`` / ``data_updated`` / ``turn_completed`` 事件，端到端验证流式链路（会真实调用 LLM）。

用法::

    python tests/api_check.py            # 仅离线确定性检查
    python tests/api_check.py --live     # 额外跑一个真实对话回合 + SSE（需 .env 凭据）

退出码：全部通过 0，否则 1。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

# 让 create_app 使用临时工作区（必须在导入 app 之前设置）。
_TMP_WS = Path(tempfile.mkdtemp(prefix="nf_api_check_"))
import os  # noqa: E402

os.environ["NARRATIVE_FORGE_WORKSPACE"] = str(_TMP_WS)

from fastapi.testclient import TestClient  # noqa: E402

from narrative_forge.api.app import create_app  # noqa: E402
from narrative_forge.api.routes import _run_turn  # noqa: E402
from narrative_forge.core.models.state_validation import (  # noqa: E402
    ENGINE_VERSION,
    REPORT_SCHEMA_VERSION,
)
from narrative_forge.orchestrator import ProjectSession, TurnEvent  # noqa: E402

# 一个明确合法 / 明确非法的 world 片段（分类卡片模型），用于校验路径测试。
_VALID_WORLD = {"characters": [{"id": "char-1", "name": "阿杰", "tags": ["主角"], "image": "assets/x.png"}]}
_INVALID_WORLD = {"characters": "should-be-a-list"}  # characters 应为卡片数组


def _check(cond: bool, label: str, detail: str = "") -> bool:
    """打印单条断言结果，返回是否通过。"""
    print(f"   {'PASS' if cond else 'FAIL'}  {label}" + (f" — {detail}" if detail and not cond else ""))
    return cond


def offline_checks(app) -> bool:
    """离线确定性检查（无 LLM）：返回是否全部通过。"""
    client = TestClient(app)
    ok = True
    print("── 离线 REST / 锁检查")

    ok &= _check(client.get("/api/health").json()["status"] == "ok", "health")

    # 建项目
    r = client.post("/api/projects", json={"name": "API 自测"})
    pid = r.json()["id"]
    ok &= _check(r.status_code == 201 and not r.json()["busy"], "create project", str(r.status_code))

    # 列表含新项目
    ids = [p["id"] for p in client.get("/api/projects").json()["projects"]]
    ok &= _check(pid in ids, "list projects contains new")

    # 素材库：上传、列表、分段预览、非法参数与删除。
    r = client.post(f"/api/projects/{pid}/materials", json={"filename": "novel.txt", "content": "素材正文"})
    ok &= _check(r.status_code == 201 and r.json()["name"] == "novel.txt", "upload material", str(r.status_code))
    names = [m["name"] for m in client.get(f"/api/projects/{pid}/materials").json()["materials"]]
    ok &= _check(names == ["novel.txt"], "list materials", str(names))
    first = client.get(f"/api/projects/{pid}/materials/novel.txt?offset=0&limit=2")
    second = client.get(f"/api/projects/{pid}/materials/novel.txt?offset=2&limit=2")
    ok &= _check(
        first.status_code == 200
        and first.json()["content"] == "素材"
        and first.json()["complete"] is False
        and second.json()["content"] == "正文"
        and second.json()["complete"] is True,
        "preview material in character chunks",
        first.text,
    )
    missing = client.get(f"/api/projects/{pid}/materials/missing.txt")
    ok &= _check(missing.status_code == 404, "missing material preview -> 404", missing.text)
    invalid_preview = client.get(f"/api/projects/{pid}/materials/novel.txt?limit=200001")
    ok &= _check(invalid_preview.status_code == 422, "oversized material chunk -> 422", invalid_preview.text)
    r = client.post(f"/api/projects/{pid}/materials", json={"filename": "bad.pdf", "content": "x"})
    ok &= _check(r.status_code == 422, "reject non-text material -> 422", str(r.status_code))
    r = client.delete(f"/api/projects/{pid}/materials/novel.txt")
    ok &= _check(r.status_code == 200 and r.json()["materials"] == [], "delete material", str(r.status_code))

    # 配图上传/读取（角色/地点卡片，见 DESIGN §5.8）：base64 上传 → GET 取回二进制
    png = b"\x89PNG\r\n\x1a\n0123456789"
    b64 = base64.b64encode(png).decode()
    r = client.post(f"/api/projects/{pid}/assets", json={"filename": "hero.png", "data_b64": b64})
    ok &= _check(r.status_code == 201 and r.json()["path"].startswith("assets/"), "upload asset", str(r.status_code))
    asset_name = r.json()["name"]
    r = client.get(f"/api/projects/{pid}/assets/{asset_name}")
    ok &= _check(r.status_code == 200 and r.content == png, "get asset bytes", str(r.status_code))
    r = client.post(f"/api/projects/{pid}/assets", json={"filename": "bad.bmp", "data_b64": b64})
    ok &= _check(r.status_code == 422, "reject non-image asset -> 422", str(r.status_code))
    r = client.get(f"/api/projects/{pid}/assets/nope.png")
    ok &= _check(r.status_code == 404, "get missing asset -> 404", str(r.status_code))

    # 面板 AI 生图：后端生成资产并返回 path，不直接修改 world/revision。
    generated = SimpleNamespace(
        name="generated-test.png",
        path="assets/generated-test.png",
        model="gpt-image-2",
        size="1024x1024",
        background="opaque",
    )
    with patch(
        "narrative_forge.api.routes.agenerate_card_image_asset",
        new_callable=AsyncMock,
        return_value=generated,
    ) as generate_mock:
        r = client.post(
            f"/api/projects/{pid}/assets/generate",
            json={
                "category": "characters",
                "name": "测试角色",
                "description": "穿深色长袍",
                "tags": ["主角"],
            },
        )
    ok &= _check(
        r.status_code == 201 and r.json()["path"] == generated.path,
        "generate card image asset",
        str(r.status_code),
    )
    ok &= _check(
        generate_mock.call_args.kwargs["category"] == "characters",
        "generate endpoint forwards card category",
    )
    r = client.post(
        f"/api/projects/{pid}/assets/generate",
        json={"category": "factions", "name": "非法分类"},
    )
    ok &= _check(r.status_code == 422, "reject unsupported image category -> 422", str(r.status_code))

    # 手动写 intent（自由文本），revision 0 → 1
    r = client.put(f"/api/projects/{pid}/data/intent", json={"content": "赛博朋克悬疑、多结局", "base_revision": 0})
    ok &= _check(r.status_code == 200 and r.json()["revision"] == 1, "put intent r0->1", str(r.status_code))
    ok &= _check(client.get(f"/api/projects/{pid}/data/intent").json()["content"] == "赛博朋克悬疑、多结局", "get intent")

    # 乐观锁冲突：再用过期 base_revision=0 → 409
    r = client.put(f"/api/projects/{pid}/data/intent", json={"content": "x", "base_revision": 0})
    ok &= _check(r.status_code == 409, "stale base_revision -> 409", str(r.status_code))

    # 手动写合法 world，r0 -> 1
    r = client.put(f"/api/projects/{pid}/data/world", json={"content": _VALID_WORLD, "base_revision": 0})
    ok &= _check(r.status_code == 200 and r.json()["revision"] == 1, "put valid world", str(r.status_code))

    # 非法 world -> 422
    r = client.put(f"/api/projects/{pid}/data/world", json={"content": _INVALID_WORLD, "base_revision": 1})
    ok &= _check(r.status_code == 422, "invalid world -> 422", str(r.status_code))

    # 上游 revision 变化不再产生产品级“过时”状态，旧依赖基线也不暴露给前端。
    client.put(f"/api/projects/{pid}/data/intent", json={"content": "改了意图", "base_revision": 1})
    proj = client.get(f"/api/projects/{pid}").json()
    ok &= _check(
        all(key not in proj for key in ("stale", "scene_stale", "based_on", "scene_based_on")),
        "project state omits legacy staleness fields",
        json.dumps(proj, ensure_ascii=False),
    )

    # 编辑锁：模拟项目忙 → 手改 423、对话 409
    app.state.locks._busy.add(pid)
    ok &= _check(client.put(f"/api/projects/{pid}/data/intent", json={"content": "y"}).status_code == 423, "busy -> put 423")
    ok &= _check(
        client.post(
            f"/api/projects/{pid}/assets/generate",
            json={"category": "locations", "name": "忙时地点"},
        ).status_code == 423,
        "busy -> image generation 423",
    )
    ok &= _check(client.post(f"/api/projects/{pid}/chat", json={"message": "hi"}).status_code == 409, "busy -> chat 409")
    app.state.locks._busy.discard(pid)
    ok &= _check(
        client.post(f"/api/projects/{pid}/chat/stop").status_code == 409,
        "idle chat stop -> 409",
    )
    run_state = client.get(f"/api/projects/{pid}/chat/run").json()
    ok &= _check(run_state["status"] == "idle", "chat run idle before any turn", str(run_state))

    # 未知片段类型 / 不存在项目
    ok &= _check(client.get(f"/api/projects/{pid}/data/nope").status_code == 404, "unknown data type -> 404")
    ok &= _check(client.get("/api/projects/__missing__").status_code == 404, "missing project -> 404")

    preview = app.state.turn_workspaces.begin(pid, "preview-turn")
    preview.draft_store.set_text(pid, "intent", "预览意图")
    snapshot = app.state.turn_workspaces.publish_checkpoint(preview, step_id="root")
    ok &= _check(snapshot is not None, "checkpoint publish after legal draft write")
    r = client.get(f"/api/projects/{pid}/chat/preview/preview-turn/{snapshot.generation}")
    ok &= _check(
        r.status_code == 200
        and r.json()["preview_generation"] == snapshot.generation
        and r.json()["fragments"]["intent"] == "预览意图",
        "preview bundle immutable GET",
        str(r.status_code),
    )
    canonical_intent = client.get(f"/api/projects/{pid}/data/intent").json().get("content")
    ok &= _check(canonical_intent != "预览意图", "formal GET unchanged during generation")

    png_v1 = b"\x89PNG\r\n\x1a\n" + b"generation-one"
    png_v2 = b"\x89PNG\r\n\x1a\n" + b"generation-two"
    asset_dir = preview.draft_store.assets_dir(pid)
    asset_dir.mkdir(parents=True, exist_ok=True)
    (asset_dir / "hero.png").write_bytes(png_v1)
    world = preview.draft_store.get_data(pid, "world") or {}
    characters = list(world.get("characters") or [])
    if characters:
        characters[0] = {**characters[0], "image": "assets/hero.png"}
        world["characters"] = characters
        preview.draft_store.set_data(pid, "world", world)
    snap_img = app.state.turn_workspaces.publish_checkpoint(preview, step_id="assets")
    ok &= _check(snap_img is not None, "checkpoint with world and new image")
    bundle = client.get(f"/api/projects/{pid}/chat/preview/preview-turn/{snap_img.generation}").json()
    ok &= _check(
        "hero.png" in (bundle.get("preview_assets") or {}).get("names", [])
        and bundle.get("preview_assets", {}).get("generation") == snap_img.generation,
        "preview bundle exposes frozen asset identifiers",
        str(bundle.get("preview_assets")),
    )
    asset_r = client.get(
        f"/api/projects/{pid}/chat/preview/preview-turn/{snap_img.generation}/assets/hero.png"
    )
    ok &= _check(
        asset_r.status_code == 200
        and asset_r.content == png_v1
        and "image/png" in (asset_r.headers.get("content-type") or ""),
        "preview asset endpoint returns original bytes and MIME",
        f"{asset_r.status_code} {asset_r.headers.get('content-type')}",
    )
    next_asset = asset_dir / "hero.png.next"
    next_asset.write_bytes(png_v2)
    next_asset.replace(asset_dir / "hero.png")
    snap_img2 = app.state.turn_workspaces.publish_checkpoint(preview, step_id="assets-2")
    old_asset = client.get(
        f"/api/projects/{pid}/chat/preview/preview-turn/{snap_img.generation}/assets/hero.png"
    )
    new_asset = client.get(
        f"/api/projects/{pid}/chat/preview/preview-turn/{snap_img2.generation}/assets/hero.png"
    )
    ok &= _check(old_asset.content == png_v1, "old generation asset bytes stay frozen")
    ok &= _check(new_asset.content == png_v2, "new generation can use replaced image")

    draft_fp = preview.draft_store.validation_fingerprint(pid)
    preview.draft_store.save_validation_record(
        pid,
        fingerprint=draft_fp,
        report={
            "status": "failed",
            "engine_version": ENGINE_VERSION,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "issues": [],
        },
    )
    formal_validation = client.get(f"/api/projects/{pid}/validation").json()
    ok &= _check(
        formal_validation.get("status") != "failed",
        "draft validation does not refresh formal GET during generation",
        str(formal_validation.get("status")),
    )

    app.state.turn_workspaces.revoke_previews(preview, "aborted")
    r = client.get(f"/api/projects/{pid}/chat/preview/preview-turn/{snapshot.generation}")
    ok &= _check(r.status_code == 409, "revoked preview is 409", str(r.status_code))
    revoked_asset = client.get(
        f"/api/projects/{pid}/chat/preview/preview-turn/{snap_img.generation}/assets/hero.png"
    )
    ok &= _check(revoked_asset.status_code == 409, "revoked preview asset is 409")
    r = client.get(f"/api/projects/{pid}/chat/preview/missing/1")
    ok &= _check(r.status_code == 404, "unknown preview is 404", str(r.status_code))

    return bool(ok)


# 一张最小事件图（含状态变量），供场景层测试作上游（事件层已声明变量供 effect 引用）。
_EVENTS_FOR_SCENE = {
    "state_variables": [
        {"id": "rel", "name": "关系", "type": "enum", "allowed": ["敌对", "盟友"], "initial": "敌对"},
        {"id": "pow", "name": "武力", "type": "scalar", "min": 0, "max": 100, "initial": 1},
    ],
    "nodes": [
        {"id": "ev-a", "title": "起始事件", "type": "mainline"},
        {"id": "ev-end", "title": "结局", "type": "ending"},
    ],
    "edges": [
        {
            "id": "e1",
            "source": "ev-a",
            "target": "ev-end",
            "condition": {"var": "pow", "op": ">=", "value": 6},
        }
    ],
}
# 世界设定（含地点卡片），供场景层 beat.location 硬引用校验（见 DESIGN §5.8(b)）。
_WORLD_FOR_SCENE = {"locations": [{"id": "loc-1", "name": "起始之地"}]}
# 合法情节图：两 beat 一边、effect 引用已声明变量、beat.location 引用已存在地点。
_VALID_SCENE = {
    "event_id": "ev-a",
    "beats": [
        {"id": "b1", "kind": "narration", "location": "loc-1", "content": "开场", "effects": [{"var": "rel", "op": "set", "value": "盟友"}]},
        {"id": "b2", "kind": "narration", "location": "loc-1", "content": "收尾", "effects": [{"var": "pow", "op": "add", "value": 5}]},
    ],
    "edges": [
        {
            "id": "s1",
            "source": "b1",
            "target": "b2",
            "condition": {"var": "rel", "op": "==", "value": "盟友"},
        }
    ],
}
# 非法情节图：effect 引用未声明变量 + set 值越界。
_INVALID_SCENE = {
    "event_id": "ev-a",
    "beats": [{"id": "b1", "kind": "narration", "location": "loc-1", "effects": [{"var": "nope", "op": "set", "value": 1}]}],
    "edges": [],
}


def scene_checks(app) -> bool:
    """离线检查场景层（阶段 4）REST：总览/读写/校验/乐观锁（无 LLM）。"""
    client = TestClient(app)
    ok = True
    print("── 场景层 REST 检查（无 LLM）")

    pid = client.post("/api/projects", json={"name": "场景自测"}).json()["id"]
    empty_usages = client.get(f"/api/projects/{pid}/state-variable-usages")
    ok &= _check(
        empty_usages.status_code == 200 and empty_usages.json().get("variables") == [],
        "empty project state-variable-usages is []",
        f"{empty_usages.status_code} {empty_usages.text}",
    )
    # 先铺世界设定（含地点卡片，供 beat.location 硬引用）与事件图（含状态变量声明）作场景上游
    rw = client.put(f"/api/projects/{pid}/data/world", json={"content": _WORLD_FOR_SCENE, "base_revision": 0})
    ok &= _check(rw.status_code == 200, "put world (upstream, locations)", str(rw.status_code))
    r = client.put(f"/api/projects/{pid}/data/events", json={"content": _EVENTS_FOR_SCENE, "base_revision": 0})
    ok &= _check(r.status_code == 200, "put events (upstream)", str(r.status_code))

    # 总览：两个事件、均未生成情节
    scenes = client.get(f"/api/projects/{pid}/scenes").json()["scenes"]
    ok &= _check(
        [s["event_id"] for s in scenes] == ["ev-a", "ev-end"] and not any(s["has_scene"] for s in scenes),
        "scene overview lists events, none has scene", str(scenes),
    )

    # 保存合法情节图 r0 -> 1
    r = client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": _VALID_SCENE, "base_revision": 0})
    ok &= _check(r.status_code == 200 and r.json()["revision"] == 1, "put valid scene r0->1", str(r.status_code))
    ok &= _check(client.get(f"/api/projects/{pid}/scenes/ev-a").json()["exists"] is True, "get scene exists")
    usages = client.get(
        f"/api/projects/{pid}/state-variable-usages"
    ).json()["variables"]
    usage_by_id = {item["variable_id"]: item for item in usages}
    ok &= _check(
        [item["object_id"] for item in usage_by_id["rel"]["writes"]] == ["b1"]
        and [item["object_id"] for item in usage_by_id["rel"]["reads"]] == ["s1"]
        and [item["object_id"] for item in usage_by_id["pow"]["writes"]] == ["b2"]
        and [item["object_id"] for item in usage_by_id["pow"]["reads"]] == ["e1"],
        "state variable usage index covers scene writes and both condition layers",
        json.dumps(usages, ensure_ascii=False),
    )

    # 非法情节图（引用未声明变量 + 越界）-> 422
    r = client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": _INVALID_SCENE, "base_revision": 1})
    ok &= _check(r.status_code == 422, "invalid scene -> 422", str(r.status_code))

    # beat.location 引用世界设定不存在的地点 -> 422（P2 硬引用校验，见 DESIGN §5.8(b)）
    bad_loc = json.loads(json.dumps(_VALID_SCENE))
    bad_loc["beats"][0]["location"] = "loc-ghost"
    r = client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": bad_loc, "base_revision": 1})
    ok &= _check(r.status_code == 422, "scene with unknown location -> 422", str(r.status_code))

    # 乐观锁冲突：过期 base_revision=0 -> 409
    r = client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": _VALID_SCENE, "base_revision": 0})
    ok &= _check(r.status_code == 409, "stale scene base_revision -> 409", str(r.status_code))

    # 改上游 events(r1->2) 后，场景总览不再派生或返回“过时”字段。
    client.put(f"/api/projects/{pid}/data/events", json={"content": _EVENTS_FOR_SCENE, "base_revision": 1})
    scenes = client.get(f"/api/projects/{pid}/scenes").json()["scenes"]
    a = next(s for s in scenes if s["event_id"] == "ev-a")
    ok &= _check(a["has_scene"] and "stale" not in a, "scene overview omits stale state", str(a))

    # 编辑锁：忙时保存 -> 423
    app.state.locks._busy.add(pid)
    r = client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": _VALID_SCENE})
    ok &= _check(r.status_code == 423, "busy -> put scene 423", str(r.status_code))
    app.state.locks._busy.discard(pid)

    # 非法事件 id -> 404
    ok &= _check(client.get(f"/api/projects/{pid}/scenes/..%2Fx").status_code in (404, 400), "illegal event id rejected")

    # speaker 硬引用：dialogue 必须存卡片 id；自由名称不能保存；删除仍被占用的卡片会指出 beat。
    speaker_pid = client.post("/api/projects", json={"name": "发言人硬引用"}).json()["id"]
    speaker_world = {
        "locations": [{"id": "loc-1", "name": "起始之地"}],
        "characters": [
            {
                "id": "char-1",
                "name": "林衡",
                "description": "",
                "tags": [],
                "image": "",
            }
        ],
    }
    rw = client.put(
        f"/api/projects/{speaker_pid}/data/world",
        json={"content": speaker_world, "base_revision": 0},
    )
    ok &= _check(rw.status_code == 200, "put world with speaker card", str(rw.status_code))
    revents = client.put(
        f"/api/projects/{speaker_pid}/data/events",
        json={"content": _EVENTS_FOR_SCENE, "base_revision": 0},
    )
    ok &= _check(revents.status_code == 200, "put events for speaker scene", str(revents.status_code))
    id_scene = {
        "event_id": "ev-a",
        "beats": [
            {
                "id": "b-talk",
                "kind": "dialogue",
                "speaker": "char-1",
                "location": "loc-1",
                "content": "你好",
                "effects": [],
            },
            {
                "id": "b-end",
                "kind": "narration",
                "speaker": "",
                "location": "loc-1",
                "content": "结束",
                "effects": [],
            },
        ],
        "edges": [{"id": "e-talk", "source": "b-talk", "target": "b-end"}],
    }
    r = client.put(
        f"/api/projects/{speaker_pid}/scenes/ev-a",
        json={"content": id_scene, "base_revision": 0},
    )
    ok &= _check(
        r.status_code == 200 and r.json()["revision"] == 1,
        "dialogue speaker card id can save",
        str(r.status_code),
    )
    free_name_scene = json.loads(json.dumps(id_scene))
    free_name_scene["beats"][0]["speaker"] = "超级系统"
    r = client.put(
        f"/api/projects/{speaker_pid}/scenes/ev-a",
        json={"content": free_name_scene, "base_revision": 1},
    )
    ok &= _check(
        r.status_code == 422 and "超级系统" in r.text,
        "free-name speaker cannot save",
        r.text,
    )
    unknown_scene = json.loads(json.dumps(id_scene))
    unknown_scene["beats"][0]["speaker"] = "oth-missing"
    r = client.put(
        f"/api/projects/{speaker_pid}/scenes/ev-a",
        json={"content": unknown_scene, "base_revision": 1},
    )
    ok &= _check(
        r.status_code == 422 and "oth-missing" in r.text,
        "unknown speaker id cannot save",
        r.text,
    )
    orphan_world = {
        "locations": [{"id": "loc-1", "name": "起始之地"}],
        "characters": [],
    }
    r = client.put(
        f"/api/projects/{speaker_pid}/data/world",
        json={"content": orphan_world, "base_revision": 1},
    )
    ok &= _check(
        r.status_code == 422 and "b-talk" in r.text and "ev-a" in r.text,
        "deleting referenced speaker card reports event and beat",
        r.text,
    )
    return bool(ok)


def reachability_checks(app) -> bool:
    """离线检查数值可达性软校验端点（``GET /reachability``，无 LLM，见 DESIGN §4.2(f)3）。

    构造"事件边要求 pow≥50、但情节只加 5"的不可达场景应报 warning；把门槛降到可达则清空。
    """
    client = TestClient(app)
    ok = True
    print("── 数值可达性软校验 REST 检查（无 LLM）")

    pid = client.post("/api/projects", json={"name": "可达性自测"}).json()["id"]
    # 世界设定（含地点卡片）：供后续 PUT /scenes 的 beat.location 硬引用校验。
    client.put(f"/api/projects/{pid}/data/world", json={"content": _WORLD_FOR_SCENE, "base_revision": 0})

    # 事件图：ev-a → ev-end 的边要求 pow ≥ 50（scalar 阈值）。
    events = json.loads(json.dumps(_EVENTS_FOR_SCENE))  # 深拷贝，避免污染共享常量
    events["edges"][0]["condition"] = {"var": "pow", "op": ">=", "value": 50}
    client.put(f"/api/projects/{pid}/data/events", json={"content": events, "base_revision": 0})

    # 无情节时：pow 恒为初始 1，够不到 50 → 报 warning（结构化项含 message/edge_id）。
    warns = client.get(f"/api/projects/{pid}/reachability").json()["warnings"]
    ok &= _check(
        len(warns) == 1 and "武力 >= 50" in warns[0]["message"] and warns[0]["edge_id"] == "e1",
        "unreachable threshold warned", str(warns),
    )

    # 生成一张只 +5 的情节（1+5=6 < 50）→ 仍不可达，仍报。
    client.put(f"/api/projects/{pid}/scenes/ev-a", json={"content": _VALID_SCENE, "base_revision": 0})
    warns = client.get(f"/api/projects/{pid}/reachability").json()["warnings"]
    ok &= _check(len(warns) == 1, "still unreachable after small add", str(warns))

    # 当前版本已有正式传播结论时，创作期预检必须隐藏，避免与更准确的正式报告并列。
    store = app.state.store
    store.save_validation_record(
        pid,
        fingerprint=store.validation_fingerprint(pid),
        report={
            "engine_version": ENGINE_VERSION,
            "report_schema_version": REPORT_SCHEMA_VERSION,
            "status": "failed",
            "summary": {"issue_count": 1},
            "issues": [],
            "warnings": [],
            "complexity": {},
            "meta": {"propagation_ran": True},
        },
    )
    warns = client.get(f"/api/projects/{pid}/reachability").json()["warnings"]
    ok &= _check(warns == [], "formal result hides numeric precheck", str(warns))
    ok &= _check(
        client.get(f"/api/projects/{pid}/progressability").status_code == 404,
        "retired speculative deadend endpoint",
    )

    # 修改内容使正式报告失效后，当前内容仍明显达不到门槛，数值预检重新出现。
    events["edges"][0]["label"] = "保持高门槛"
    cur = client.get(f"/api/projects/{pid}/data/events").json()["revision"]
    client.put(f"/api/projects/{pid}/data/events", json={"content": events, "base_revision": cur})
    warns = client.get(f"/api/projects/{pid}/reachability").json()["warnings"]
    ok &= _check(len(warns) == 1, "content edit restores numeric precheck", str(warns))

    # 把门槛降到 5（可达）→ 无 warning。
    events["edges"][0]["condition"] = {"var": "pow", "op": ">=", "value": 5}
    cur = client.get(f"/api/projects/{pid}/data/events").json()["revision"]
    client.put(f"/api/projects/{pid}/data/events", json={"content": events, "base_revision": cur})
    warns = client.get(f"/api/projects/{pid}/reachability").json()["warnings"]
    ok &= _check(warns == [], "reachable threshold no warning", str(warns))
    return bool(ok)


# 结局事件的最小情节图（供全路径模拟走到结局；结局事件也需有情节才能通关，见 DESIGN §4.4(b)）。
_END_SCENE = {
    "event_id": "ev-end",
    "beats": [{"id": "b1", "kind": "narration", "location": "loc-1", "content": "结局", "effects": []}],
    "edges": [],
}


def state_validation_api_checks(app) -> bool:
    """检查后台正式检测的持久化状态与内容指纹失效。"""
    client = TestClient(app)
    client.__enter__()
    ok = True
    print("── 完整联合状态检测 REST 检查（无 LLM）")

    pid = client.post("/api/projects", json={"name": "路线检测自测"}).json()["id"]
    client.put(
        f"/api/projects/{pid}/data/world",
        json={"content": _WORLD_FOR_SCENE, "base_revision": 0},
    )
    client.put(
        f"/api/projects/{pid}/data/events",
        json={"content": _EVENTS_FOR_SCENE, "base_revision": 0},
    )

    state = client.get(f"/api/projects/{pid}/validation").json()
    ok &= _check(state["status"] == "not_checked", "new content starts not checked", str(state))
    ok &= _check(
        client.get(f"/api/projects/{pid}/simulation").status_code == 404,
        "legacy simulation product endpoint removed",
    )

    run_state = client.post(f"/api/projects/{pid}/validation/run").json()
    deadline = time.monotonic() + 3
    while (
        run_state["status"] in {"running", "cancelling"}
        and time.monotonic() < deadline
    ):
        time.sleep(0.01)
        run_state = client.get(
            f"/api/projects/{pid}/validation/run"
        ).json()
    state = client.get(f"/api/projects/{pid}/validation").json()
    ok &= _check(
        state["status"] == "incomplete"
        and state["report"]["status"] == "incomplete",
        "missing scenes reported incomplete without propagation",
        str({"run": run_state, "validation": state}),
    )
    persisted = client.get(f"/api/projects/{pid}/validation").json()
    ok &= _check(
        persisted["status"] == "incomplete" and bool(persisted["checked_at"]),
        "validation result persisted",
        str(persisted),
    )

    changed = json.loads(json.dumps(_EVENTS_FOR_SCENE))
    changed["nodes"][0]["title"] = "修改后的事件"
    client.put(
        f"/api/projects/{pid}/data/events",
        json={"content": changed, "base_revision": 1},
    )
    current = client.get(f"/api/projects/{pid}/validation").json()
    ok &= _check(
        current["status"] == "not_checked" and current["report"] is None,
        "content change hides old validation result",
        str(current),
    )
    client.__exit__(None, None, None)
    return bool(ok)


def agent_changeset_api_checks(app) -> bool:
    """检查修改集查询、明确保留、整轮撤销和 revision 冲突响应。"""
    client = TestClient(app)
    store = app.state.store
    service = app.state.agent_changesets
    project = store.create_project("修改集 API 检查")
    store.set_text(project.id, "intent", "回合前")
    store.bump_revision(project.id, "intent")
    baseline = service.capture_baseline(project.id)
    store.set_text(project.id, "intent", "Agent 修改")
    store.bump_revision(project.id, "intent")
    first = service.complete(project.id, "api-turn-1", baseline)
    assert first is not None
    store.append_chat(
        project.id,
        {"role": "assistant", "text": "已修改", "changeset": first.model_dump()},
    )

    ok = True
    print("── Agent 修改集 REST 检查（无 LLM）")
    latest = client.get(f"/api/projects/{project.id}/agent-changesets/latest")
    ok &= _check(
        latest.status_code == 200
        and latest.json()["changeset"]["id"] == first.id,
        "latest changeset restored",
        latest.text,
    )
    kept = client.post(
        f"/api/projects/{project.id}/agent-changesets/{first.id}/keep"
    )
    ok &= _check(
        kept.status_code == 200
        and kept.json()["changeset"]["status"] == "kept",
        "explicit keep",
        kept.text,
    )
    history = client.get(f"/api/projects/{project.id}/history")
    ok &= _check(
        history.json()["messages"][-1]["changeset"]["status"] == "kept",
        "history hydrates current changeset status",
        history.text,
    )

    baseline = service.capture_baseline(project.id)
    store.set_text(project.id, "intent", "第二轮 Agent 修改")
    store.bump_revision(project.id, "intent")
    second = service.complete(project.id, "api-turn-2", baseline)
    assert second is not None
    reverted = client.post(
        f"/api/projects/{project.id}/agent-changesets/{second.id}/revert"
    )
    ok &= _check(
        reverted.status_code == 200
        and reverted.json()["changeset"]["status"] == "reverted"
        and store.get_text(project.id, "intent") == "Agent 修改",
        "whole-turn revert",
        reverted.text,
    )

    baseline = service.capture_baseline(project.id)
    store.set_text(project.id, "intent", "第三轮 Agent 修改")
    store.bump_revision(project.id, "intent")
    third = service.complete(project.id, "api-turn-3", baseline)
    assert third is not None
    store.set_text(project.id, "intent", "后续人工修改")
    store.bump_revision(project.id, "intent")
    conflict = client.post(
        f"/api/projects/{project.id}/agent-changesets/{third.id}/revert"
    )
    ok &= _check(
        conflict.status_code == 409
        and store.get_text(project.id, "intent") == "后续人工修改",
        "revert conflict preserves later edit",
        conflict.text,
    )
    return bool(ok)


class _StubSession:
    """假会话：不调用 LLM，直接吐出固定的过程事件，用于验证 _run_turn → 事件总线的接线。"""

    async def astream_turn(self, message: str, **_kwargs):  # noqa: D401
        yield TurnEvent("status", {"text": "stub status"})
        yield TurnEvent(
            "tool_start",
            {
                "tool": "task",
                "subagent": "world-builder",
                "label": "正在执行 world-builder 子 Agent",
                "step_id": "outer",
                "parent_step_id": None,
            },
        )
        yield TurnEvent(
            "tool_start",
            {
                "tool": "read_file",
                "label": "正在阅读资料",
                "step_id": "inner",
                "parent_step_id": "outer",
            },
        )
        yield TurnEvent("agent_text", {"text": "你好", "agent": "main-agent", "step_id": "outer"})
        yield TurnEvent("tool_end", {"tool": "read_file", "step_id": "inner"})
        yield TurnEvent("tool_end", {"tool": "task", "step_id": "outer"})
        yield TurnEvent("completed", {"text": "done", "updated": [["intent", 1]], "failed": {}, "repairs": 0})


class _FailingSession:
    """用于确认失败 error 事件带 turn_id。"""

    async def astream_turn(self, message: str, **_kwargs):  # noqa: D401
        del message
        yield TurnEvent("tool_start", {"tool": "read_file", "step_id": "s1"})
        raise RuntimeError("boom")


class _SlowSession:
    """POST 202 后立即查询 /chat/run 时应已是 running。"""

    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def astream_turn(self, message: str, **_kwargs):  # noqa: D401
        del message
        self.started.set()
        await asyncio.sleep(0.4)
        yield TurnEvent("completed", {"text": "done", "updated": [], "failed": {}, "repairs": 0, "committed": True})


class _StubEventAgent:
    """产生嵌套及并行同名工具事件，验证会话层保留调用身份和父子关系。"""

    async def astream_events(self, inputs, version, config):  # noqa: D401
        del inputs, version, config
        yield {
            "event": "on_tool_start",
            "name": "task",
            "run_id": "outer",
            "parent_ids": ["root"],
            "data": {"input": {"subagent_type": "world-builder"}},
        }
        yield {
            "event": "on_tool_start",
            "name": "read_file",
            "run_id": "read-1",
            # 模拟部分框架版本丢失外层 task run_id；同名 lc_agent_name 应补回父关系。
            "parent_ids": ["root", "inner-chain"],
            "metadata": {"lc_agent_name": "world-builder"},
            "data": {"input": {}},
        }
        yield {
            "event": "on_tool_start",
            "name": "read_file",
            "run_id": "read-2",
            "parent_ids": ["root", "outer", "inner-chain"],
            "data": {"input": {}},
        }
        # 故意先结束较早启动的同名工具，确认结束事件不是“最近同名项”语义。
        yield {
            "event": "on_tool_end",
            "name": "read_file",
            "run_id": "read-1",
            "parent_ids": ["root", "outer", "inner-chain"],
            "data": {},
        }
        yield {
            "event": "on_tool_end",
            "name": "read_file",
            "run_id": "read-2",
            "parent_ids": ["root", "outer", "inner-chain"],
            "data": {},
        }
        yield {
            "event": "on_tool_end",
            "name": "task",
            "run_id": "outer",
            "parent_ids": ["root"],
            "data": {},
        }


async def step_hierarchy_check(app) -> bool:
    """离线验证嵌套步骤和并行同名工具使用稳定的唯一 ID。"""
    print("── Agent 步骤层级检查（无 LLM）")
    store = app.state.store
    pid = store.create_project("步骤层级测试").id
    session = ProjectSession(store, pid, agent=_StubEventAgent())
    events = [event async for event in session._astream_agent()]
    starts = [event.data for event in events if event.type == "tool_start"]
    ends = [event.data for event in events if event.type == "tool_end"]

    ok = True
    ok &= _check(
        [event["step_id"] for event in starts] == ["outer", "read-1", "read-2"],
        "tool starts preserve unique ids",
        str(starts),
    )
    ok &= _check(
        [event["parent_step_id"] for event in starts] == [None, "outer", "outer"],
        "nested tools point to nearest visible parent",
        str(starts),
    )
    ok &= _check(
        [event["step_id"] for event in ends] == ["read-1", "read-2", "outer"],
        "parallel same-name tool ends preserve invocation ids",
        str(ends),
    )
    return bool(ok)


async def bus_wiring_check(app) -> bool:
    """离线验证 ``_run_turn`` 把过程事件正确广播到事件总线，并在结束后释放编辑锁。"""
    print("── 事件总线 / _run_turn 接线检查（无 LLM）")
    bus, locks, store = app.state.bus, app.state.locks, app.state.store
    pid = store.create_project("接线测试").id  # 真实项目目录，确保对话可落盘
    queue = bus.subscribe(pid)
    await locks.acquire(pid)
    await _run_turn(store, bus, locks, _StubSession(), pid, "x")

    got: list[str] = []
    texts = 0
    process_events: list[dict] = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev["type"] in {"text", "agent_text"}:
            texts += 1
        else:
            got.append(ev["type"])
        if ev["type"] in {"tool_start", "tool_end"}:
            process_events.append(ev)
    bus.unsubscribe(pid, queue)

    ok = True
    expected = [
        "turn_start",
        "status",
        "tool_start",
        "tool_start",
        "tool_end",
        "tool_end",
        "data_updated",
        "turn_completed",
        "turn_end",
    ]
    ok &= _check(got == expected, "event sequence", f"got={got}")
    ok &= _check(texts == 1, "agent_text forwarded", f"texts={texts}")
    ok &= _check(not locks.is_busy(pid), "lock released after turn")
    ok &= _check(
        [event.get("step_id") for event in process_events]
        == ["outer", "inner", "inner", "outer"],
        "step ids forwarded through event bus",
        str(process_events),
    )

    # 对话落盘 + 还原：user + assistant 两条，助手消息带步骤。
    chat = store.get_chat(pid)
    roles = [m.get("role") for m in chat]
    ok &= _check(roles == ["user", "assistant"], "chat persisted (user+assistant)", f"roles={roles}")
    ok &= _check(
        bool(chat and chat[-1].get("steps")), "assistant steps persisted",
        f"steps={chat[-1].get('steps') if chat else None}",
    )
    persisted_steps = chat[-1].get("steps", []) if chat else []
    ok &= _check(
        [step.get("parent_step_id") for step in persisted_steps] == [None, "outer"]
        and all(step.get("done") for step in persisted_steps),
        "assistant step hierarchy persisted as completed",
        str(persisted_steps),
    )

    fail_pid = store.create_project("失败信封").id
    fail_queue = bus.subscribe(fail_pid)
    await locks.acquire(fail_pid)
    await _run_turn(store, bus, locks, _FailingSession(), fail_pid, "x", turn_id="err-turn")
    error_events = []
    while not fail_queue.empty():
        ev = fail_queue.get_nowait()
        if ev["type"] == "error":
            error_events.append(ev)
    bus.unsubscribe(fail_pid, fail_queue)
    ok &= _check(
        error_events and error_events[0].get("turn_id") == "err-turn",
        "error SSE carries turn_id",
        str(error_events),
    )
    return bool(ok)


def chat_run_immediate_check(app) -> bool:
    """POST /chat 202 后立即 GET /chat/run 必须返回同一 turn_id 和 running。"""
    print("── POST 202 后立即校准 /chat/run")
    store = app.state.store
    pid = store.create_project("启动竞态").id
    session = _SlowSession()
    original_get = app.state.sessions.get
    app.state.sessions.get = lambda _pid: session
    ok = True
    try:
        with TestClient(app) as client:
            started = client.post(f"/api/projects/{pid}/chat", json={"message": "hi"})
            run = client.get(f"/api/projects/{pid}/chat/run").json()
            ok &= _check(started.status_code == 202, "POST /chat 202", str(started.status_code))
            ok &= _check(
                run.get("turn_id") == started.json().get("turn_id") and run.get("status") == "running",
                "GET /chat/run matches POST turn_id while running",
                str(run),
            )
            deadline = time.time() + 5
            while time.time() < deadline:
                if client.get(f"/api/projects/{pid}/chat/run").json().get("status") != "running":
                    break
                time.sleep(0.05)
    finally:
        app.state.sessions.get = original_get
    return bool(ok)


async def replay_buffer_check(app) -> bool:
    """离线验证 ``EventBus`` 的"当前回合重放缓冲"（见 DESIGN §6.9(7)）。

    覆盖三种"切回/重连"场景：回合进行中重连应补播已发生事件；回合结束后重连不应重放
    （改由历史还原）；回合外的事件（如手动 ``data_updated``）不应进缓冲。
    """
    print("── 事件重放缓冲检查（无 LLM）")
    bus = app.state.bus
    pid = "replay-test"

    async def drain(q) -> list[str]:
        out: list[str] = []
        while not q.empty():
            out.append((await q.get())["type"])
        return out

    ok = True
    # 1) 回合进行中、无订阅者时发生的事件，重连后应被补播。
    bus.publish(pid, {"type": "turn_start"})
    bus.publish(pid, {"type": "tool_start", "label": "A"})
    bus.publish(pid, {"type": "agent_text", "text": "hi", "sequence": 1, "turn_id": "t1"})
    q = bus.subscribe(pid)
    ok &= _check(
        await drain(q) == ["turn_start", "tool_start", "agent_text"],
        "mid-turn reconnect replays buffer",
    )
    # 2) 重连后的实时事件正常投递；回合完成 + 结束后缓冲清空。
    bus.publish(pid, {"type": "tool_end"})
    ok &= _check(await drain(q) == ["tool_end"], "live event after reconnect")
    bus.publish(pid, {"type": "turn_completed", "text": "done"})
    bus.publish(pid, {"type": "turn_end"})
    bus.unsubscribe(pid, q)
    q2 = bus.subscribe(pid)
    ok &= _check(await drain(q2) == [], "post-end reconnect replays nothing")
    bus.unsubscribe(pid, q2)
    # 2b) 停止请求进缓冲；turn_stopped 清空，避免重连看到已撤销预览。
    bus.publish(pid, {"type": "turn_start"})
    bus.publish(pid, {"type": "data_preview_published", "turn_id": "t1", "preview_generation": 1})
    bus.publish(pid, {"type": "turn_stop_requested", "turn_id": "t-stop"})
    q_stop = bus.subscribe(pid)
    ok &= _check(
        await drain(q_stop) == ["turn_start", "data_preview_published", "turn_stop_requested"],
        "stop request stays in replay buffer",
    )
    bus.publish(pid, {"type": "turn_stopped", "rolled_back": True})
    bus.publish(pid, {"type": "turn_end"})
    bus.unsubscribe(pid, q_stop)
    q_after_stop = bus.subscribe(pid)
    ok &= _check(await drain(q_after_stop) == [], "stopped turn does not replay revoked preview")
    bus.unsubscribe(pid, q_after_stop)
    # 3) 回合外的事件不进缓冲（不会被后续重连误重放）。
    bus.publish(pid, {"type": "data_updated", "data_type": "world"})
    q3 = bus.subscribe(pid)
    ok &= _check(await drain(q3) == [], "out-of-turn event not buffered")
    bus.unsubscribe(pid, q3)
    return bool(ok)


async def live_check(app) -> bool:
    """实跑一个 intent 对话回合（真实 LLM），直接消费 ``session.astream_turn`` 的流式事件。

    直接驱动会话层而非经 httpx-SSE，避免测试客户端对长连接的缓冲干扰；SSE 转发链路由
    :func:`bus_wiring_check` 离线覆盖。
    """
    print("── 实时流式对话检查（真实 LLM）")
    store, sessions = app.state.store, app.state.sessions
    meta = store.create_project("Live 自测")
    store.add_material(meta.id, "source.txt", "一个发生在雨夜霓虹都市的侦探故事，主角是一名失忆的私家侦探。")
    session = sessions.get(meta.id)

    texts = 0
    tool_starts: list[str] = []
    completed: dict | None = None
    try:
        async def run() -> None:
            nonlocal texts, completed
            async for ev in session.astream_turn(
                "请把我的创作意图记录一下：赛博朋克悬疑基调、做成多结局分支。"
            ):
                if ev.type in {"text", "agent_text"}:
                    texts += 1
                elif ev.type == "tool_start":
                    tool_starts.append(ev.data.get("tool"))
                elif ev.type == "completed":
                    completed = ev.data

        await asyncio.wait_for(run(), timeout=280.0)
    except asyncio.TimeoutError:
        print("   FAIL  live: astream_turn 超时未完成")
        return False

    ok = True
    ok &= _check(completed is not None, "got completed event")
    ok &= _check(texts > 0, "received streaming agent_text", f"texts={texts}")
    ok &= _check(len(tool_starts) > 0, "received tool_start", f"tools={tool_starts}")
    intent = store.get_text(meta.id, "intent")
    ok &= _check(bool(intent.strip()), "intent.md persisted", f"len={len(intent)}")
    ok &= _check(any(dt == "intent" for dt, _ in (completed or {}).get("updated", [])),
                 "intent in updated", json.dumps(completed, ensure_ascii=False)[:150])
    print(f"   （texts={texts}, tools={tool_starts}, updated={(completed or {}).get('updated')}）")
    return bool(ok)


def main(argv: list[str] | None = None) -> int:
    """入口：跑离线检查（默认）+ 可选 --live。"""
    parser = argparse.ArgumentParser(description="Narrative Forge API 自测")
    parser.add_argument("--live", action="store_true", help="额外跑真实对话 + SSE（需 LLM 凭据）")
    args = parser.parse_args(argv)

    app = create_app()
    passed = offline_checks(app)
    passed = scene_checks(app) and passed
    passed = reachability_checks(app) and passed
    passed = state_validation_api_checks(app) and passed
    passed = agent_changeset_api_checks(app) and passed
    passed = asyncio.run(step_hierarchy_check(app)) and passed
    passed = asyncio.run(bus_wiring_check(app)) and passed
    passed = chat_run_immediate_check(app) and passed
    passed = asyncio.run(replay_buffer_check(app)) and passed
    if args.live:
        passed = asyncio.run(live_check(app)) and passed

    print("\n==== 结果 ====")
    print("全部通过 ✅" if passed else "存在失败 ❌")
    print(f"（临时工作区 {_TMP_WS}）")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
