"""离线单测：跨层数值可达性软校验（见 DESIGN §4.2(f)3）。

不调用 LLM，纯用 :func:`reachability_warnings` 验证"再乐观也够不到"的 scalar 事件边阈值
能被检出、而可达阈值不误报：

- scalar 门槛在全图场景 effect 累加后可达 → 无 warning；
- scalar 门槛超出全图可达上界（含"无情节改动该变量") → 报 warning；
- 下界方向（``<`` / ``<=``）门槛低于可达下界 → 报 warning；
- enum/flag 门槛、以及场景把 scalar 抬够的情形 → 不报（零误报）。

用法::

    PYTHONPATH=. python tests/reachability_check.py

退出码：全部断言通过返回 0，否则返回 1。
"""

from __future__ import annotations

import sys

from narrative_forge.core.validation import reachability_warnings


def _fail(msg: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {msg}")
    raise SystemExit(1)


def _events(condition: dict | None) -> dict:
    """构造一张最小事件图：入口 → 结局，出边带给定 scalar 条件。"""
    edge = {"id": "e1", "source": "start", "target": "end"}
    if condition is not None:
        edge["condition"] = condition
    return {
        "state_variables": [
            {"id": "power", "name": "武力", "type": "scalar", "min": 0, "max": 100, "initial": 1},
            {"id": "seclusion", "name": "闭关", "type": "flag", "initial": False},
        ],
        "nodes": [
            {"id": "start", "title": "起始", "type": "mainline"},
            {"id": "end", "title": "结局", "type": "ending"},
        ],
        "edges": [edge],
    }


def _scene(effects: list[dict]) -> dict:
    """构造一张最小情节图：单个终止 beat 承载给定 effects。"""
    return {
        "event_id": "start",
        "beats": [{"id": "b1", "kind": "narration", "content": "推进。", "effects": effects}],
        "edges": [],
    }


def _expect_ok(events: dict, scenes: list[dict], label: str) -> None:
    """断言无可达性 warning。"""
    warns = reachability_warnings(events, scenes)
    if warns:
        _fail(f"{label} 不应报 warning，却报了：{warns}")
    print(f"   PASS  {label}")


def _expect_warn(events: dict, scenes: list[dict], label: str, needle: str) -> None:
    """断言报出可达性 warning（结构化项 {message,edge_id,var}），message 含 ``needle``。"""
    warns = reachability_warnings(events, scenes)
    if not warns:
        _fail(f"{label} 应报 warning，却没有")
    if not any(needle in w.get("message", "") for w in warns):
        _fail(f"{label} 的 warning 应含『{needle}』，实际：{warns}")
    # 结构化项须带 edge_id（供前端图上精确标红）。
    if not all(w.get("edge_id") for w in warns):
        _fail(f"{label} 的 warning 缺 edge_id：{warns}")
    print(f"   PASS  {label}")


def run_check() -> bool:
    """跑一遍可达性软校验断言，全过返回 True。"""
    # 无 scalar 条件 → 不报。
    _expect_ok(_events(None), [_scene([])], "无条件边不报")

    # flag 门槛（非 scalar）→ 不报。
    _expect_ok(_events({"var": "seclusion", "op": "==", "value": True}), [_scene([])], "flag 门槛不报")

    # power ≥ 50，但全图无任何 effect 改动 power（初始 1）→ 报"无情节改动"。
    _expect_warn(
        _events({"var": "power", "op": ">=", "value": 50}),
        [_scene([])],
        "无 effect 抬升的高门槛报警",
        "没有任何情节 effect",
    )

    # power ≥ 50，场景累加 add 40（1+40=41 < 50）→ 仍不可达，报警。
    _expect_warn(
        _events({"var": "power", "op": ">=", "value": 50}),
        [_scene([{"var": "power", "op": "add", "value": 40}])],
        "累加仍够不到的门槛报警",
        "武力 >= 50",
    )

    # power ≥ 50，场景累加 add 60（1+60=61 ≥ 50）→ 可达，不报。
    _expect_ok(
        _events({"var": "power", "op": ">=", "value": 50}),
        [_scene([{"var": "power", "op": "add", "value": 60}])],
        "累加够到的门槛不报",
    )

    # power ≥ 50，场景 set 到里程碑 80 → 可达，不报（set 纳入起点候选）。
    _expect_ok(
        _events({"var": "power", "op": ">=", "value": 50}),
        [_scene([{"var": "power", "op": "set", "value": 80}])],
        "set 跳档够到的门槛不报",
    )

    # 下界方向：power < 0 恒不可达（min=0，下界 ≥ 0）→ 报警。
    _expect_warn(
        _events({"var": "power", "op": "<", "value": 0}),
        [_scene([{"var": "power", "op": "add", "value": 5}])],
        "低于可达下界的门槛报警",
        "武力 < 0",
    )

    # 上界正好等于阈值：power > 41（上界 41）→ 严格大于够不到，报警。
    _expect_warn(
        _events({"var": "power", "op": ">", "value": 41}),
        [_scene([{"var": "power", "op": "add", "value": 40}])],
        "严格大于恰好等于上界报警",
        "武力 > 41",
    )

    # 事件图缺失 / 非法 → 安全返回空。
    if reachability_warnings(None, []) != []:
        _fail("events 缺失应返回空")
    if reachability_warnings({"nodes": "bad"}, []) != []:
        _fail("events 非法应返回空")
    print("   PASS  缺失/非法输入安全返回空")

    return True


def main() -> int:
    """CLI 入口：跑可达性软校验断言。"""
    print("── 跨层数值可达性软校验断言 运行中 ...")
    run_check()
    print("\n==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
