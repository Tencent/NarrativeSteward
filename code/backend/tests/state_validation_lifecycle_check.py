"""正式联合状态检测生命周期回归检查。

覆盖缺 scene 不传播、完整项目保存、后续编辑失效、取消/异常释放项目锁，以及报告写入失败时保留旧记录。
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

_WORKSPACE = Path(tempfile.mkdtemp(prefix="nf_state_lifecycle_"))
os.environ["NARRATIVE_FORGE_WORKSPACE"] = str(_WORKSPACE)

from fastapi.testclient import TestClient  # noqa: E402

from narrative_forge.agents.validation_tool import (  # noqa: E402
    build_latest_validation_tool,
)
from narrative_forge.api.app import create_app  # noqa: E402
from narrative_forge.core.models.state_validation import (  # noqa: E402
    REPORT_SCHEMA_VERSION,
)
from narrative_forge.core.state_validation_service import (  # noqa: E402
    StateValidationCancelled,
    run_state_validation_for_project,
)


def _world() -> dict:
    """构造含 ``test-location`` 的合法世界设定，满足 beat.location 硬引用。"""
    return {
        "worldview": [],
        "characters": [],
        "locations": [
            {
                "id": "test-location",
                "name": "测试地点",
                "description": "",
                "tags": [],
                "image": "",
            }
        ],
        "factions": [],
        "history": [],
        "other": [],
    }


def _events() -> dict:
    """构造 start → ending 的最小完整事件图。"""
    return {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "ending", "title": "结束", "type": "ending"},
        ],
        "edges": [{"id": "to-ending", "source": "start", "target": "ending"}],
    }


def _scene(event_id: str) -> dict:
    """构造单个终止 beat 的合法 scene。"""
    return {
        "event_id": event_id,
        "beats": [
            {
                "id": f"{event_id}-beat",
                "kind": "narration",
                "location": "test-location",
                "content": event_id,
                "effects": [],
            }
        ],
        "edges": [],
    }


def _failed_events() -> dict:
    """构造条件永远不满足、可生成正式失败报告的事件图。"""
    return {
        "state_variables": [
            {
                "id": "gate",
                "name": "通行许可",
                "type": "flag",
                "initial": False,
            }
        ],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "ending", "title": "结束", "type": "ending"},
        ],
        "edges": [
            {
                "id": "locked",
                "source": "start",
                "target": "ending",
                "condition": {"var": "gate", "op": "==", "value": True},
            }
        ],
    }


def _wait_until(predicate, timeout: float = 3.0) -> bool:
    """轮询条件直到成立或超时。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def run_check() -> None:
    """执行正式检测生命周期全部断言。"""
    app = create_app()
    store = app.state.store

    partial = store.create_project("部分 scene")
    store.set_data(partial.id, "world", _world())
    store.set_data(partial.id, "events", _events())
    store.set_scene(partial.id, "ending", _scene("ending"))
    partial_result = run_state_validation_for_project(store, partial.id)
    assert partial_result["status"] == "incomplete"
    assert partial_result["report"]["meta"]["propagation_ran"] is False
    assert {
        issue["event_id"]
        for issue in partial_result["report"]["issues"]
        if issue["kind"] == "scene_missing"
    } == {"start"}
    print("   PASS  任意部分 scene 返回 incomplete 且不运行传播")

    complete = store.create_project("完整项目")
    store.set_data(complete.id, "world", _world())
    store.set_data(complete.id, "events", _events())
    store.set_scene(complete.id, "start", _scene("start"))
    store.set_scene(complete.id, "ending", _scene("ending"))
    passed = run_state_validation_for_project(store, complete.id)
    assert passed["status"] == "passed"
    assert passed["report"]["meta"]["propagation_ran"] is True
    assert "memory_limit_bytes" in passed["report"]["meta"]
    assert "memory_stop_bytes" in passed["report"]["meta"]
    assert "elapsed_ms" in passed["report"]["meta"]
    assert "propagation_elapsed_ms" in passed["report"]["meta"]
    assert "route_restore_elapsed_ms" in passed["report"]["meta"]
    elapsed_ms = passed["report"]["meta"]["elapsed_ms"]
    propagation_elapsed_ms = passed["report"]["meta"]["propagation_elapsed_ms"]
    route_restore_elapsed_ms = passed["report"]["meta"]["route_restore_elapsed_ms"]
    assert elapsed_ms >= 0
    assert propagation_elapsed_ms >= 0
    assert route_restore_elapsed_ms >= 0
    assert elapsed_ms >= propagation_elapsed_ms
    assert elapsed_ms >= route_restore_elapsed_ms
    assert passed["report"]["report_schema_version"] == REPORT_SCHEMA_VERSION
    old_record = store.validation_file(complete.id).read_text(encoding="utf-8")
    print("   PASS  完整项目运行正式传播并原子保存报告")

    failed_project = store.create_project("Agent 读取失败报告")
    failed_events = _failed_events()
    store.set_data(failed_project.id, "world", _world())
    store.set_data(failed_project.id, "events", failed_events)
    store.set_scene(failed_project.id, "start", _scene("start"))
    store.set_scene(failed_project.id, "ending", _scene("ending"))
    failed = run_state_validation_for_project(store, failed_project.id)
    assert failed["status"] == "failed"
    read_tool = build_latest_validation_tool(store, failed_project.id)
    current_report = read_tool.invoke(
        {"kind": "event_edge_never_enabled", "limit": 1}
    )
    assert current_report["status"] == "failed"
    assert current_report["matched_issue_count"] >= 1
    assert current_report["variable_names"]["gate"] == "通行许可"
    locked_issue = next(
        issue
        for issue in current_report["issues"]
        if issue["kind"] == "event_edge_never_enabled"
    )
    assert locked_issue["condition"]["var"] == "gate"
    assert locked_issue["reachable_values"] == [False]
    assert locked_issue["route"]["step_count"] > 0
    assert "steps" not in locked_issue["route"]
    store.set_data(
        failed_project.id,
        "events",
        {
            **failed_events,
            "edges": [{**failed_events["edges"][0], "label": "已修改"}],
        },
    )
    stale_report = read_tool.invoke({})
    assert stale_report["status"] == "not_checked"
    assert stale_report["issues"] == []
    print("   PASS  Agent 可分页读取当前报告且不会读取失效旧结论")

    store.set_scene(
        complete.id,
        "ending",
        {
            **_scene("ending"),
            "beats": [
                {
                    **_scene("ending")["beats"][0],
                    "content": "修改后的结局",
                }
            ],
        },
    )
    assert store.validation_state(complete.id)["status"] == "not_checked"
    print("   PASS  后续内容保存使旧结论失效")

    cancel = threading.Event()
    cancel.set()
    try:
        run_state_validation_for_project(
            store,
            complete.id,
            cancel_event=cancel,
        )
    except StateValidationCancelled:
        pass
    else:
        raise AssertionError("预置取消标志必须中止检测")
    assert store.validation_file(complete.id).read_text(encoding="utf-8") == old_record
    print("   PASS  取消不覆盖已有正式报告")

    store.set_scene(complete.id, "ending", _scene("ending"))
    with patch.object(
        store,
        "_atomic_write_text",
        side_effect=OSError("模拟原子替换失败"),
    ):
        try:
            run_state_validation_for_project(store, complete.id)
        except OSError:
            pass
        else:
            raise AssertionError("写入失败必须向调用方报告")
    assert store.validation_file(complete.id).read_text(encoding="utf-8") == old_record
    print("   PASS  报告写入失败不会留下半份新记录")

    client = TestClient(app)
    client.__enter__()
    api_complete = store.create_project("API 正式检测")
    store.set_data(api_complete.id, "world", _world())
    store.set_data(api_complete.id, "events", _events())
    store.set_scene(api_complete.id, "start", _scene("start"))
    store.set_scene(api_complete.id, "ending", _scene("ending"))
    assert client.post(
        f"/api/projects/{api_complete.id}/validation/run"
    ).status_code == 200
    assert _wait_until(
        lambda: client.get(
            f"/api/projects/{api_complete.id}/validation/run"
        ).json()["status"]
        == "completed"
    )
    assert client.get(
        f"/api/projects/{api_complete.id}/validation"
    ).json()["status"] == "passed"
    assert _wait_until(
        lambda: client.get(f"/api/projects/{api_complete.id}").json()["busy"]
        is False
    )
    print("   PASS  后台 API 完整执行并登记 passed")

    lifecycle = store.create_project("API 生命周期")

    def blocking_validation(*args, cancel_event, progress_callback, **kwargs):
        """模拟长任务，直到收到取消请求。"""
        progress_callback(
            {
                "phase": "propagating",
                "configs_explored": 10,
                "complete": False,
            }
        )
        while not cancel_event.is_set():
            time.sleep(0.01)
        raise StateValidationCancelled("测试取消")

    with patch(
        "narrative_forge.api.routes.run_state_validation_for_project",
        side_effect=blocking_validation,
    ):
        started = client.post(f"/api/projects/{lifecycle.id}/validation/run")
        assert started.status_code == 200
        assert client.post(
            f"/api/projects/{lifecycle.id}/validation/run"
        ).status_code == 409
        assert client.get(f"/api/projects/{lifecycle.id}").json()["busy"] is True
        blocked = client.put(
            f"/api/projects/{lifecycle.id}/data/intent",
            json={"content": "不能保存", "base_revision": 0},
        )
        assert blocked.status_code == 423
        assert client.post(
            f"/api/projects/{lifecycle.id}/validation/cancel"
        ).status_code == 200
        assert _wait_until(
            lambda: client.get(
                f"/api/projects/{lifecycle.id}/validation/run"
            ).json()["status"]
            == "cancelled"
        )
        assert _wait_until(
            lambda: client.get(
                f"/api/projects/{lifecycle.id}"
            ).json()["busy"]
            is False
        )
    print("   PASS  检测只读、不可重复启动、可取消并释放 busy")

    failed = store.create_project("API 异常")
    with patch(
        "narrative_forge.api.routes.run_state_validation_for_project",
        side_effect=RuntimeError("模拟内部错误"),
    ):
        assert client.post(
            f"/api/projects/{failed.id}/validation/run"
        ).status_code == 200
        assert _wait_until(
            lambda: client.get(
                f"/api/projects/{failed.id}/validation/run"
            ).json()["status"]
            == "error"
        )
        assert _wait_until(
            lambda: client.get(f"/api/projects/{failed.id}").json()["busy"]
            is False
        )
    assert store.get_validation_record(failed.id) is None
    print("   PASS  内部异常不写报告并释放 busy")
    client.__exit__(None, None, None)


if __name__ == "__main__":
    print("── 正式检测生命周期断言 运行中 ...")
    run_check()
    print("\n全部通过 ✅")
