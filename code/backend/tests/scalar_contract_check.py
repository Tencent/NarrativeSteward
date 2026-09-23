"""离线单测：全部 scalar 的双侧有界整数保存契约。

用法：``PYTHONPATH=. python tests/scalar_contract_check.py``。
"""

from __future__ import annotations

import sys

from narrative_forge.core.validation import (
    compact_playability_report,
    state_validation_report,
    validate_data,
    validate_project_scalar_contract,
    validate_scene,
)

_LOCATIONS = [{"id": "loc", "name": "地点"}]


def _fail(message: str) -> None:
    """打印失败信息并中止测试。"""
    print(f"   FAIL  {message}")
    raise SystemExit(1)


def _assert(result: bool, message: str) -> None:
    """断言条件成立。"""
    if not result:
        _fail(message)


def _events(variable: dict, condition: dict | None = None) -> dict:
    """构造最小合法事件图。"""
    edge = {"id": "event-edge", "source": "start", "target": "end"}
    if condition is not None:
        edge["condition"] = condition
    return {
        "state_variables": [variable],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "end", "title": "结束", "type": "ending"},
        ],
        "edges": [edge],
    }


def _scene(event_id: str, *, effect_value: float | int | None = None) -> dict:
    """构造单 beat scene，可选写入 scalar。"""
    effects = []
    if effect_value is not None:
        effects.append({"var": "score", "op": "add", "value": effect_value})
    return {
        "event_id": event_id,
        "beats": [
            {
                "id": "beat",
                "kind": "narration",
                "location": "loc",
                "content": "内容",
                "effects": effects,
            }
        ],
        "edges": [],
    }


def run_check() -> bool:
    """运行保存契约和紧凑传播兼容断言。"""
    invalid_unbounded = {
        "id": "score",
        "name": "分数",
        "type": "scalar",
        "initial": 0.5,
    }
    ok, message = validate_data("events", _events(invalid_unbounded))
    _assert(not ok and "min/max" in message, "未被读取的 scalar 也必须双侧有界")

    unused_variable = {
        "id": "score",
        "name": "暂未使用分数",
        "type": "scalar",
        "min": 0,
        "max": 10,
        "initial": 0,
    }
    unused_events = _events(unused_variable)
    unused_scenes = [
        _scene("start", effect_value=1),
        _scene("end"),
    ]
    compact = compact_playability_report(unused_events, unused_scenes)
    _assert(compact["meta"]["complete"] is True, "未读取整数 scalar 不应阻断传播")
    _assert(compact["meta"]["packed_bits"] == 0, "未读取 scalar 不应进入状态编码")
    formal_unused = state_validation_report(
        unused_events,
        unused_scenes,
    )
    _assert(formal_unused["status"] == "passed", "未读取变量提醒不应改变通过状态")
    _assert(
        formal_unused["warnings"][0]["kind"] == "state_variable_never_read",
        "正式报告应提示未读取变量",
    )
    print("   PASS  全部 scalar 有界整数，未读取变量只提醒且不进入状态键")

    conditional_variable = {
        "id": "score",
        "name": "条件分数",
        "type": "scalar",
        "min": 0,
        "max": 10,
        "initial": 0,
    }
    condition = {"var": "score", "op": ">=", "value": 5}
    ok, message = validate_data(
        "events",
        _events(conditional_variable, condition),
    )
    _assert(ok, f"双侧有界整数 scalar 应通过：{message}")

    for patch, expected in (
        ({"max": None}, "min/max"),
        ({"max": 10.5}, "integer"),
        ({"initial": 0.5}, "initial"),
    ):
        variable = {**conditional_variable, **patch}
        ok, message = validate_data("events", _events(variable, condition))
        _assert(not ok and expected in message, f"应拒绝 {patch}：{message}")
    float_condition = {"var": "score", "op": ">=", "value": 5.5}
    ok, message = validate_data(
        "events",
        _events(conditional_variable, float_condition),
    )
    _assert(not ok and "比较值" in message, "应拒绝小数 condition value")
    print("   PASS  scalar 声明和比较值必须是整数")

    project_events = _events(conditional_variable)
    float_effect_scene = _scene("start", effect_value=0.5)
    ok, message = validate_project_scalar_contract(
        project_events,
        [float_effect_scene, _scene("end")],
    )
    _assert(not ok and "effect" in message, "全项目校验应拒绝任意 scalar 小数 effect")
    print("   PASS  跨事件/scene 保存视图检查全部 effects")

    own_condition_scene = {
        "event_id": "start",
        "beats": [
            {
                "id": "a",
                "kind": "narration",
                "location": "loc",
                "content": "A",
                "effects": [{"var": "score", "op": "add", "value": 0.5}],
            },
            {
                "id": "b",
                "kind": "narration",
                "location": "loc",
                "content": "B",
                "effects": [],
            },
        ],
        "edges": [
            {
                "id": "scene-edge",
                "source": "a",
                "target": "b",
                "condition": {"var": "score", "op": ">=", "value": 1},
            }
        ],
    }
    ok, message = validate_scene(
        own_condition_scene,
        [conditional_variable],
        _LOCATIONS,
    )
    _assert(not ok and "effect" in message, "scene 本地保存应拒绝小数 effect")

    formal_invalid = state_validation_report(
        _events({**conditional_variable, "max": 10.5}, condition),
        [_scene("start"), _scene("end")],
    )
    _assert(
        formal_invalid["issues"][0]["kind"] == "events_invalid",
        "非法 scalar 声明应作为事件 schema 错误",
    )
    print("   PASS  scene 保存和正式报告使用全局整数契约")
    return True


def main() -> int:
    """CLI 入口。"""
    print("── 全局 scalar 保存契约断言 运行中 ...")
    run_check()
    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
