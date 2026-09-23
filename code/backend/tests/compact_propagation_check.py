"""离线回归：紧凑联合状态传播原型。

本脚本验证位编码、位置存活变量分析、拓扑释放和遗留字典传播在小图上的结论等价性，不调用 LLM。

用法::

    PYTHONPATH=. python tests/compact_propagation_check.py
"""

from __future__ import annotations

import random
import sys

from narrative_forge.core.models.state_validation import REPORT_SCHEMA_VERSION
from narrative_forge.core.models.compact_propagation import PackedStateCodec
from narrative_forge.core.models.event_graph import StateVariable
from narrative_forge.core.models.scene_graph import Effect
from narrative_forge.core.validation import (
    compact_playability_report,
    playability_report,
    state_validation_report,
)


def _fail(message: str) -> None:
    """打印失败原因并终止测试。

    Args:
        message: 面向开发者的断言说明。
    """
    print(f"   FAIL  {message}")
    raise SystemExit(1)


def _equal(actual, expected, label: str) -> None:
    """断言两个值相等。

    Args:
        actual: 实际值。
        expected: 期望值。
        label: 断言名称。
    """
    if actual != expected:
        _fail(f"{label}：期望 {expected!r}，实际 {actual!r}")


def _beat(
    beat_id: str,
    effects: list[dict] | None = None,
) -> dict:
    """构造最小 beat。

    Args:
        beat_id: beat id。
        effects: 可选状态写入。

    Returns:
        可供 Pydantic 解析的 beat 字典。
    """
    return {
        "id": beat_id,
        "kind": "narration",
        "location": "test-location",
        "content": beat_id,
        "effects": effects or [],
    }


def _scene(
    event_id: str,
    beats: list[dict],
    edges: list[dict] | None = None,
) -> dict:
    """构造最小 scene。

    Args:
        event_id: 所属事件。
        beats: beat 列表。
        edges: scene 边列表。

    Returns:
        scene 原始字典。
    """
    return {
        "event_id": event_id,
        "beats": beats,
        "edges": edges or [],
    }


def _linear_events(
    variables: list[dict] | None = None,
    condition: dict | None = None,
) -> dict:
    """构造 start → fin 的两事件图。

    Args:
        variables: 状态变量声明。
        condition: start → fin 的可选条件。

    Returns:
        事件图原始字典。
    """
    edge = {"id": "event-edge", "source": "start", "target": "fin"}
    if condition is not None:
        edge["condition"] = condition
    return {
        "state_variables": variables or [],
        "nodes": [
            {"id": "start", "title": "开始", "type": "mainline"},
            {"id": "fin", "title": "结束", "type": "ending"},
        ],
        "edges": [edge],
    }


def _compare_reports(events: dict, scenes: list[dict], label: str) -> dict:
    """比较遗留传播和紧凑传播的核心存在性结论。

    Args:
        events: 事件图。
        scenes: scene 列表。
        label: 当前案例名称。

    Returns:
        紧凑传播报告。
    """
    legacy = playability_report(
        events,
        scenes,
        max_configs=None,
        max_depth=None,
    )
    compact = compact_playability_report(events, scenes)
    if compact.get("summary", {}).get("note"):
        _fail(f"{label} 紧凑传播未运行：{compact['summary']['note']}")
    for key in (
        "ending_coverage",
        "endings_reached",
        "endings_total",
        "has_dead_end",
        "blocked_event_count",
        "reachable_event_count",
        "total_event_count",
        "unreachable_event_count",
        "condition_satisfaction_rate",
    ):
        _equal(
            compact["summary"][key],
            legacy["summary"][key],
            f"{label} summary.{key}",
        )
    if compact["summary"]["dead_end_count"] > legacy["summary"]["dead_end_count"]:
        _fail(
            f"{label} 压缩后的行为等价死路状态不应多于旧全局变量投影："
            f"{compact['summary']['dead_end_count']} > "
            f"{legacy['summary']['dead_end_count']}"
        )
    _equal(
        compact["unreachable_nodes"],
        legacy["unreachable_nodes"],
        f"{label} 不可达节点",
    )
    _equal(
        compact["condition_satisfaction"],
        legacy["condition_satisfaction"],
        f"{label} 条件边覆盖",
    )
    return compact


def _check_codec() -> None:
    """验证位编码、读取、set/add 和边界截断。"""
    declarations = [
        StateVariable(id="flag", name="旗标", type="flag", initial=False),
        StateVariable(
            id="route",
            name="路线",
            type="enum",
            allowed=["a", "b", "c", "d", "e"],
            initial="c",
        ),
        StateVariable(
            id="score",
            name="分数",
            type="scalar",
            min=-2,
            max=10,
            initial=3,
        ),
    ]
    codec = PackedStateCodec(declarations)
    # flag=1 bit，5 值 enum=3 bit，13 值 scalar=4 bit。
    _equal(codec.total_bits, 8, "编码总位数")
    state = codec.encode_initial()
    _equal(codec.decode_value("flag", state), False, "flag 初值")
    _equal(codec.decode_value("route", state), "c", "enum 初值")
    _equal(codec.decode_value("score", state), 3, "scalar 初值")

    state = codec.apply_effects(
        state,
        [
            Effect(var="flag", op="set", value=True),
            Effect(var="route", op="set", value="e"),
            Effect(var="score", op="add", value=20),
        ],
    )
    _equal(codec.decode_value("flag", state), True, "flag set")
    _equal(codec.decode_value("route", state), "e", "enum set")
    _equal(codec.decode_value("score", state), 10, "scalar add 上界截断")
    print("   PASS  位编码与 effects")


def _check_equivalence() -> None:
    """验证典型分支、死路、缺内容和变量投影的结论等价。"""
    linear_events = _linear_events()
    linear_scenes = [
        _scene("start", [_beat("s")]),
        _scene("fin", [_beat("f")]),
    ]
    linear = _compare_reports(linear_events, linear_scenes, "线性图")
    _equal(linear["edge_coverage"]["used"], 1, "线性图全部正式边可用")

    gate_variables = [
        {
            "id": "gate",
            "name": "门",
            "type": "flag",
            "initial": False,
        }
    ]
    dead_events = _linear_events(
        gate_variables,
        {"var": "gate", "op": "==", "value": True},
    )
    dead = _compare_reports(dead_events, linear_scenes, "条件死路")
    _equal(dead["dead_ends"]["count"], 1, "条件死路数量")
    _equal(dead["edge_coverage"]["used"], 0, "不可解锁边未覆盖")

    blocked = _compare_reports(
        linear_events,
        [_scene("start", [_beat("s")])],
        "缺少情节",
    )
    _equal(blocked["blocked"]["events"], ["fin"], "阻断事件")

    variables = [
        {
            "id": "score",
            "name": "分数",
            "type": "scalar",
            "min": 0,
            "max": 10,
            "initial": 0,
        },
        {
            "id": "mood",
            "name": "心情",
            "type": "enum",
            "allowed": ["calm", "bold"],
            "initial": "calm",
        },
    ]
    branch_events = _linear_events(variables)
    branch_scene = _scene(
        "start",
        [
            _beat("choice"),
            _beat(
                "left",
                [
                    {"var": "score", "op": "add", "value": 1},
                    {"var": "mood", "op": "set", "value": "bold"},
                ],
            ),
            _beat("right", [{"var": "score", "op": "add", "value": 1}]),
            _beat("gate"),
            _beat("done"),
        ],
        [
            {"id": "l", "source": "choice", "target": "left"},
            {"id": "r", "source": "choice", "target": "right"},
            {"id": "lg", "source": "left", "target": "gate"},
            {"id": "rg", "source": "right", "target": "gate"},
            {
                "id": "gd",
                "source": "gate",
                "target": "done",
                "condition": {"var": "score", "op": ">=", "value": 1},
            },
        ],
    )
    projected = _compare_reports(
        branch_events,
        [branch_scene, _scene("fin", [_beat("f")])],
        "无关变量合流",
    )
    top = {
        item["position"]: item
        for item in projected["state_space"]["top_positions"]
    }
    _equal(top["BT:start:gate"]["states"], 1, "mood 被投影后两路合流")
    print("   PASS  遗留传播与紧凑传播核心结论等价")


def _check_set_kills_old_value() -> None:
    """验证无条件 set 能精确消除进入前旧值差异。"""
    variables = [
        {
            "id": "score",
            "name": "分数",
            "type": "scalar",
            "min": 0,
            "max": 10,
            "initial": 0,
        }
    ]
    events = _linear_events(variables)
    scene = _scene(
        "start",
        [
            _beat("choice"),
            _beat("one", [{"var": "score", "op": "set", "value": 1}]),
            _beat("two", [{"var": "score", "op": "set", "value": 2}]),
            _beat("overwrite", [{"var": "score", "op": "set", "value": 5}]),
            _beat("done"),
        ],
        [
            {"id": "c1", "source": "choice", "target": "one"},
            {"id": "c2", "source": "choice", "target": "two"},
            {"id": "o1", "source": "one", "target": "overwrite"},
            {"id": "o2", "source": "two", "target": "overwrite"},
            {
                "id": "od",
                "source": "overwrite",
                "target": "done",
                "condition": {"var": "score", "op": "==", "value": 5},
            },
        ],
    )
    report = compact_playability_report(
        events,
        [scene, _scene("fin", [_beat("f")])],
    )
    top = {
        item["position"]: item
        for item in report["state_space"]["top_positions"]
    }
    _equal(
        top["BT:start:overwrite"]["states"],
        1,
        "set 前旧 score 应在进入 overwrite 前合流",
    )
    _equal(report["summary"]["dead_end_count"], 0, "set 后条件可满足")
    print("   PASS  set 覆盖旧值的存活分析")


def _random_condition(rng: random.Random) -> dict:
    """构造一个类型合法的随机单变量条件。

    Args:
        rng: 固定种子的随机数生成器。

    Returns:
        condition 原始字典。
    """
    variable = rng.choice(("flag", "route", "score"))
    if variable == "flag":
        return {
            "var": variable,
            "op": rng.choice(("==", "!=")),
            "value": rng.choice((False, True)),
        }
    if variable == "route":
        return {
            "var": variable,
            "op": rng.choice(("==", "!=")),
            "value": rng.choice(("a", "b", "c")),
        }
    return {
        "var": variable,
        "op": rng.choice(("==", "!=", ">", ">=", "<", "<=")),
        "value": rng.randrange(4),
    }


def _random_effect(rng: random.Random) -> dict:
    """构造一个类型合法的随机 effect。

    Args:
        rng: 固定种子的随机数生成器。

    Returns:
        effect 原始字典。
    """
    variable = rng.choice(("flag", "route", "score"))
    if variable == "flag":
        return {
            "var": variable,
            "op": "set",
            "value": rng.choice((False, True)),
        }
    if variable == "route":
        return {
            "var": variable,
            "op": "set",
            "value": rng.choice(("a", "b", "c")),
        }
    operation = rng.choice(("set", "add"))
    return {
        "var": variable,
        "op": operation,
        "value": rng.randrange(4) if operation == "set" else rng.choice((-1, 1)),
    }


def _check_deterministic_fuzz_equivalence() -> None:
    """用固定随机小 DAG 对照两套传播器，覆盖更多 effects/condition 组合。"""
    rng = random.Random(20260814)
    variables = [
        {"id": "flag", "name": "旗标", "type": "flag", "initial": False},
        {
            "id": "route",
            "name": "路线",
            "type": "enum",
            "allowed": ["a", "b", "c"],
            "initial": "a",
        },
        {
            "id": "score",
            "name": "分数",
            "type": "scalar",
            "min": 0,
            "max": 3,
            "initial": 0,
        },
    ]
    for case_index in range(40):
        beats = [
            _beat(
                f"b{index}",
                [_random_effect(rng)] if rng.random() < 0.7 else [],
            )
            for index in range(7)
        ]
        edges: list[dict] = []
        for index in range(6):
            edge = {
                "id": f"c{case_index}-chain-{index}",
                "source": f"b{index}",
                "target": f"b{index + 1}",
            }
            if rng.random() < 0.55:
                edge["condition"] = _random_condition(rng)
            edges.append(edge)
            if index < 5 and rng.random() < 0.65:
                skip = {
                    "id": f"c{case_index}-skip-{index}",
                    "source": f"b{index}",
                    "target": f"b{index + 2}",
                }
                if rng.random() < 0.7:
                    skip["condition"] = _random_condition(rng)
                edges.append(skip)

        event_condition = _random_condition(rng) if rng.random() < 0.6 else None
        events = _linear_events(variables, event_condition)
        scenes = [
            _scene("start", beats, edges),
            _scene("fin", [_beat("f")]),
        ]
        _compare_reports(events, scenes, f"随机小图 {case_index}")
    print("   PASS  40 组固定随机 DAG 差分等价")


def _check_formal_report_and_routes() -> None:
    """验证稳定状态、问题类型和按问题还原的路线。"""
    linear_events = _linear_events()
    linear_scenes = [
        _scene("start", [_beat("s")]),
        _scene("fin", [_beat("f")]),
    ]
    passed = state_validation_report(
        linear_events,
        linear_scenes,
    )
    _equal(passed["status"], "passed", "线性图正式状态")
    _equal(passed["report_schema_version"], REPORT_SCHEMA_VERSION, "正式报告 schema 版本")
    _equal(passed["summary"]["edges_used"], 1, "线性图边覆盖")
    _equal(passed["issues"], [], "线性图无问题")
    _equal(passed["complexity"]["condition_variables"], [], "无条件变量复杂度")

    dead_edge_events = _linear_events(
        [{"id": "gate", "name": "门", "type": "flag", "initial": False}],
        {"var": "gate", "op": "==", "value": True},
    )
    dead_edge = state_validation_report(
        dead_edge_events,
        linear_scenes,
    )
    _equal(dead_edge["status"], "failed", "永不解锁边正式状态")
    issue = next(
        item
        for item in dead_edge["issues"]
        if item["kind"] == "event_edge_never_enabled"
    )
    _equal(issue["reachable_values"], [False], "永不解锁边实际可达值")
    _equal(
        dead_edge["complexity"]["condition_variables"][0]["domain_size"],
        2,
        "复杂度报告保留条件变量真实域",
    )
    top_position = dead_edge["complexity"]["top_positions"][0]
    if not top_position["event_id"] or not top_position["position_kind"]:
        _fail("高状态位置必须包含可定位的结构字段")
    if issue["route"] is None:
        _fail("源位置可达的永不解锁边必须附解释路线")
    _equal(
        issue["route"]["target_position"],
        "ADV:start",
        "事件边解释路线目标",
    )

    dead_end_scene = _scene(
        "start",
        [_beat("gate"), _beat("done")],
        [
            {
                "id": "locked",
                "source": "gate",
                "target": "done",
                "condition": {"var": "gate", "op": "==", "value": True},
            }
        ],
    )
    dead_end = state_validation_report(
        dead_edge_events,
        [dead_end_scene, _scene("fin", [_beat("f")])],
    )
    dead_end_issue = next(
        item
        for item in dead_end["issues"]
        if item["kind"] == "dead_end_state"
    )
    if dead_end_issue["samples"][0]["route"] is None:
        _fail("真实死路状态必须附一条精确到该状态的路线")
    _equal(
        dead_end_issue["samples"][0]["state"],
        {"gate": False},
        "死路状态快照",
    )

    incomplete = state_validation_report(
        linear_events,
        [_scene("start", [_beat("s")])],
    )
    _equal(incomplete["status"], "incomplete", "缺少 scene 正式状态")
    _equal(incomplete["complexity"]["top_positions"], [], "未传播报告复杂度为空")
    print("   PASS  正式问题报告与定向路线还原")


def run_check() -> bool:
    """运行全部紧凑传播断言。

    Returns:
        全部通过时返回 ``True``。
    """
    _check_codec()
    _check_equivalence()
    _check_set_kills_old_value()
    _check_deterministic_fuzz_equivalence()
    _check_formal_report_and_routes()

    unsupported = compact_playability_report(
        _linear_events(
            [
                {
                    "id": "score",
                    "name": "分数",
                    "type": "scalar",
                    "min": 0,
                    "max": 1.5,
                    "initial": 0,
                }
            ],
            {"var": "score", "op": ">=", "value": 1},
        ),
        [_scene("start", [_beat("s")]), _scene("fin", [_beat("f")])],
    )
    _equal(unsupported["meta"]["mode"], "empty", "非整数 scalar 被 schema 明确拒绝")
    unsupported_formal = state_validation_report(
        _linear_events(
            [
                {
                    "id": "score",
                    "name": "分数",
                    "type": "scalar",
                    "min": 0,
                    "max": 1.5,
                    "initial": 0,
                }
            ],
            {"var": "score", "op": ">=", "value": 1},
        ),
        [_scene("start", [_beat("s")]), _scene("fin", [_beat("f")])],
    )
    _equal(
        unsupported_formal["issues"][0]["kind"],
        "events_invalid",
        "非整数 scalar 正式问题类型",
    )
    print("   PASS  非整数 scalar 不进入紧凑原型")
    return True


def main() -> int:
    """运行测试脚本并返回进程退出码。"""
    print("── 紧凑联合状态传播断言 运行中 ...")
    run_check()
    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
