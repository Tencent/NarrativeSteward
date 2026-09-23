"""离线回归：遗留局面去重穷举诊断器。

不调用 LLM，用 :func:`playability_report` 在最小事件图 + 情节图上验证**局面去重**遍历语义与
指标统计正确（且与前端 ``usePlaytest`` 对齐）。该模块不再承担产品正式通过判定：

- 线性通关 → 结局覆盖 1/1、无死路；
- 情节内选择分支 → 两分支合流后局面去重、结局仍可达；
- 事件边条件不可满足 → 死路（结局不可达）；
- 下游事件情节未生成 → 阻断（区别于死路）；
- scalar ``add`` 累加把门槛抬够 → 结局可达（数值语义对齐）；
- 未被任何 effect 改动的变量 → 计入未触达（var_coverage）；
- 缺失/非法输入安全返回；
- **去重穷举综合**（courage/mood 例，DESIGN §4.4(c)）：只有 B,D 组合（勇气=0）过不了门槛 →
  精确检出 1 个死路局面；无关变量 mood 被投影剔除、A,D 与 B,C 合流不重复展开。
- 无截断基准模式：``max_configs=None/max_depth=None`` 完整结束并返回状态增长与最终进度。

用法::

    PYTHONPATH=. python tests/simulation_check.py

退出码：全部断言通过返回 0，否则返回 1。
"""

from __future__ import annotations

import sys

from narrative_forge.core.validation import playability_report


def _fail(msg: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {msg}")
    raise SystemExit(1)


def _eq(actual, expected, label: str) -> None:
    """断言相等。"""
    if actual != expected:
        _fail(f"{label}：期望 {expected!r}，实际 {actual!r}")


def _terminal_beat(bid: str, effects: list[dict] | None = None) -> dict:
    """一个无出边的终止 beat（可带 effects）。"""
    return {"id": bid, "kind": "narration", "content": "推进。", "effects": effects or []}


def _scene(event_id: str, beats: list[dict], edges: list[dict] | None = None) -> dict:
    """构造一张情节图。"""
    return {"event_id": event_id, "beats": beats, "edges": edges or []}


def _run(events: dict, scenes: list[dict]) -> dict:
    """跑一次模拟，返回报告（用较小 max_configs 也够，这些图局面极少）。"""
    return playability_report(events, scenes, max_configs=10_000)


def _linear_events() -> dict:
    """start(mainline) → fin(ending)，无条件。"""
    return {
        "state_variables": [{"id": "gate", "name": "门", "type": "flag", "initial": False}],
        "nodes": [
            {"id": "start", "title": "起始", "type": "mainline"},
            {"id": "fin", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "fin"}],
    }


def run_check() -> bool:
    """跑一遍模拟验证器断言，全过返回 True。"""
    # 1) 线性通关：start 情节 → 事件边 → fin 情节 → 结局。
    ev = _linear_events()
    scenes = [_scene("start", [_terminal_beat("b1")]), _scene("fin", [_terminal_beat("b1")])]
    r = _run(ev, scenes)
    _eq(r["summary"]["ending_coverage"], 1.0, "线性通关 结局覆盖")
    _eq(r["summary"]["has_dead_end"], False, "线性通关 无死路")
    _eq(r["summary"]["dead_end_count"], 0, "线性通关 死路局面数")
    _eq(r["summary"]["blocked_event_count"], 0, "线性通关 阻断事件数")
    _eq(r["summary"]["complete"], True, "线性通关 已完整验证")
    print("   PASS  线性通关")

    # 2) 情节内选择：start 情节有 2 分支，各自收尾 → 两分支在 fin 处合流、局面去重，结局仍可达、无死路。
    start_scene = _scene(
        "start",
        [
            {"id": "c", "kind": "choice", "content": "选？", "effects": []},
            _terminal_beat("a"),
            _terminal_beat("b"),
        ],
        [
            {"id": "s1", "source": "c", "target": "a", "label": "A"},
            {"id": "s2", "source": "c", "target": "b", "label": "B"},
        ],
    )
    r = _run(_linear_events(), [start_scene, _scene("fin", [_terminal_beat("b1")])])
    _eq(r["summary"]["ending_coverage"], 1.0, "选择分支 结局覆盖")
    _eq(r["summary"]["dead_end_count"], 0, "选择分支 无死路")
    # 两个选择分支的 beat 都应被真实进入（无孤岛 beat）。
    _eq(r["unreachable_nodes"]["beats"], [], "选择分支 两分支均可达")
    print("   PASS  情节内选择分支（合流去重）")

    # 3) 事件边条件不可满足（gate 从不置真）→ 死路，结局不可达。
    ev = _linear_events()
    ev["edges"][0]["condition"] = {"var": "gate", "op": "==", "value": True}
    r = _run(ev, [_scene("start", [_terminal_beat("b1")]), _scene("fin", [_terminal_beat("b1")])])
    _eq(r["summary"]["ending_coverage"], 0.0, "不可满足条件 结局覆盖")
    _eq(r["summary"]["has_dead_end"], True, "不可满足条件 存在死路")
    _eq(r["summary"]["dead_end_count"], 1, "不可满足条件 死路局面数")
    _eq(r["endings"]["unreached"], ["fin"], "不可满足条件 未达结局")
    print("   PASS  事件边条件不可满足→死路")

    # 4) 下游事件情节未生成 → 阻断（区别于死路）。
    ev = {
        "state_variables": [],
        "nodes": [
            {"id": "start", "title": "起始", "type": "mainline"},
            {"id": "mid", "title": "中段", "type": "mainline"},
            {"id": "fin", "title": "结局", "type": "ending"},
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "mid"},
            {"id": "e2", "source": "mid", "target": "fin"},
        ],
    }
    r = _run(ev, [_scene("start", [_terminal_beat("b1")])])  # 只给 start 情节
    _eq(r["summary"]["blocked_event_count"], 1, "阻断 事件数")
    _eq(r["blocked"]["events"], ["mid"], "阻断 事件")
    _eq(r["summary"]["dead_end_count"], 0, "阻断 不应记为死路")
    print("   PASS  下游情节未生成→阻断")

    # 5) scalar add 累加抬够门槛 → 结局可达（数值语义对齐前端）。
    ev = {
        "state_variables": [{"id": "power", "name": "武力", "type": "scalar", "min": 0, "max": 100, "initial": 0}],
        "nodes": [
            {"id": "start", "title": "起始", "type": "mainline"},
            {"id": "fin", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "fin", "condition": {"var": "power", "op": ">=", "value": 10}}],
    }
    scenes = [
        _scene("start", [_terminal_beat("b1", [{"var": "power", "op": "add", "value": 10}])]),
        _scene("fin", [_terminal_beat("b1")]),
    ]
    r = _run(ev, scenes)
    _eq(r["summary"]["ending_coverage"], 1.0, "add 抬够门槛 结局覆盖")
    _eq(r["condition_satisfaction"]["satisfied"], 1, "add 抬够门槛 满足边数")
    print("   PASS  scalar add 累加抬够门槛→可达")

    # 6) 未触达变量：门槛 gate 声明却从不被 effect 改动。
    ev = _linear_events()
    r = _run(ev, [_scene("start", [_terminal_beat("b1")]), _scene("fin", [_terminal_beat("b1")])])
    untouched = [v["id"] for v in r["var_coverage"]["untouched"]]
    if "gate" not in untouched:
        _fail(f"未触达变量应含 gate，实际 {untouched}")
    print("   PASS  未触达变量统计")

    # 7) 缺失/非法输入安全返回（不抛异常）。
    if playability_report(None, [])["meta"]["mode"] != "empty":
        _fail("events 缺失应返回 empty 报告")
    if playability_report({"nodes": "bad"}, [])["meta"]["mode"] != "empty":
        _fail("events 非法应返回 empty 报告")
    print("   PASS  缺失/非法输入安全返回")

    # 8) 去重穷举综合（DESIGN §4.4(c) 的 courage/mood 例）：
    #    b1 选 A/B（A:勇气+1,心情=勇敢 / B:心情=谨慎）→ b2 选 C/D（C:勇气+1 / D:无）→ 门槛 b3
    #    出边条件"勇气≥1"→ done。只有 B,D（勇气=0）过不了门槛 = 唯一死路组合。
    #    心情从不被任何条件引用 → 被投影剔除，A,D 与 B,C（勇气都=1）合流不重复展开。
    ev = {
        "state_variables": [
            {"id": "courage", "name": "勇气", "type": "scalar", "min": 0, "max": 10, "initial": 0},
            {"id": "mood", "name": "心情", "type": "enum", "allowed": ["brave", "cautious"], "initial": "cautious"},
        ],
        "nodes": [
            {"id": "start", "title": "起始", "type": "mainline"},
            {"id": "fin", "title": "结局", "type": "ending"},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "fin"}],
    }
    start_scene = _scene(
        "start",
        [
            {"id": "b1", "kind": "choice", "content": "b1?", "effects": []},
            {"id": "pa", "kind": "narration", "content": "A", "effects": [
                {"var": "courage", "op": "add", "value": 1}, {"var": "mood", "op": "set", "value": "brave"}]},
            {"id": "pb", "kind": "narration", "content": "B", "effects": [
                {"var": "mood", "op": "set", "value": "cautious"}]},
            {"id": "b2", "kind": "choice", "content": "b2?", "effects": []},
            {"id": "pc", "kind": "narration", "content": "C", "effects": [
                {"var": "courage", "op": "add", "value": 1}]},
            {"id": "pd", "kind": "narration", "content": "D", "effects": []},
            {"id": "b3", "kind": "narration", "content": "门槛", "effects": []},
            _terminal_beat("done"),
        ],
        [
            {"id": "s1", "source": "b1", "target": "pa", "label": "A"},
            {"id": "s2", "source": "b1", "target": "pb", "label": "B"},
            {"id": "s3", "source": "pa", "target": "b2"},
            {"id": "s4", "source": "pb", "target": "b2"},
            {"id": "s5", "source": "b2", "target": "pc", "label": "C"},
            {"id": "s6", "source": "b2", "target": "pd", "label": "D"},
            {"id": "s7", "source": "pc", "target": "b3"},
            {"id": "s8", "source": "pd", "target": "b3"},
            {"id": "s9", "source": "b3", "target": "done", "condition": {"var": "courage", "op": ">=", "value": 1}},
        ],
    )
    r = _run(ev, [start_scene, _scene("fin", [_terminal_beat("z")])])
    _eq(r["summary"]["has_dead_end"], True, "去重综合 存在死路")
    _eq(r["summary"]["dead_end_count"], 1, "去重综合 唯一死路局面（勇气=0）")
    _eq(r["summary"]["ending_coverage"], 1.0, "去重综合 结局可达（存在通关组合）")
    _eq(r["meta"]["projected_vars"], 1, "去重综合 仅 courage 参与去重（mood 被剔除）")
    sample = r["dead_ends"]["samples"][0]
    if sample["state"].get("勇气") != 0:
        _fail(f"去重综合 死路样例应显示勇气=0，实际 {sample['state']}")
    print("   PASS  去重穷举综合（死路精确检出 + 投影合流）")

    # 9) 同一线性图在极小上限下截断；关闭两项上限后必须完整结束，并给出资源规划所需的增长统计。
    linear_events = _linear_events()
    linear_scenes = [
        _scene("start", [_terminal_beat("b1")]),
        _scene("fin", [_terminal_beat("b1")]),
    ]
    limited = playability_report(
        linear_events,
        linear_scenes,
        max_configs=1,
    )
    _eq(limited["meta"]["complete"], False, "极小局面上限应截断")

    progress_updates: list[dict] = []
    uncapped = playability_report(
        linear_events,
        linear_scenes,
        max_configs=None,
        max_depth=None,
        progress_callback=progress_updates.append,
        progress_every=1,
    )
    _eq(uncapped["meta"]["complete"], True, "无截断模式应完整结束")
    _eq(uncapped["meta"]["max_configs"], None, "无截断模式局面上限")
    _eq(uncapped["meta"]["max_depth"], None, "无截断模式深度上限")
    if uncapped["meta"]["configs_discovered"] < uncapped["meta"]["configs_explored"]:
        _fail("已发现局面数不应少于已展开局面数")
    if uncapped["meta"]["peak_queue_size"] < 1:
        _fail("队列峰值至少应为 1")
    if not progress_updates or progress_updates[-1]["complete"] is not True:
        _fail("无截断模式必须发送 complete=True 的最终进度")
    print("   PASS  无截断模式 + 状态增长进度")

    return True


def main() -> int:
    """CLI 入口：跑模拟验证器断言。"""
    print("── 全路径真实模拟验证器断言 运行中 ...")
    run_check()
    print("\n==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
