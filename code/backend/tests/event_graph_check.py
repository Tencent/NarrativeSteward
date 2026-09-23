"""离线单测：事件图 schema + 图结构校验（见 DESIGN §4.2）。

不调用 LLM，纯用 :func:`validate_data` 验证事件层契约：

- 合法事件图（状态变量类型化、前向 DAG、结局可达、条件引用合法）通过；
- 各类非法情形（未声明变量、成环、缺结局、端点不存在、自环、类型不自洽、
  条件取值越界、卡片多余字段等）被拒绝并给出可读原因。

用法::

    PYTHONPATH=. python tests/event_graph_check.py

退出码：全部断言通过返回 0，否则返回 1。
"""

from __future__ import annotations

import sys

from narrative_forge.core.validation import validate_data


def _fail(msg: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {msg}")
    raise SystemExit(1)


def _expect_ok(data: dict, label: str) -> None:
    """断言事件图合法。"""
    ok, msg = validate_data("events", data)
    if not ok:
        _fail(f"{label} 应合法，却被拒：{msg}")
    print(f"   PASS  {label}")


def _expect_bad(data: dict, label: str, needle: str) -> None:
    """断言事件图非法，且错误信息包含 ``needle``。"""
    ok, msg = validate_data("events", data)
    if ok:
        _fail(f"{label} 应被拒，却通过了")
    if needle not in msg:
        _fail(f"{label} 的报错应含『{needle}』，实际：{msg}")
    print(f"   PASS  {label}")


def _valid_graph() -> dict:
    """一张合法的样例事件图（拜师/闭关分支，最终汇合到结局）。"""
    return {
        "state_variables": [
            {"id": "rel", "name": "与师傅关系", "type": "enum",
             "allowed": ["敌对", "中立", "盟友"], "initial": "中立",
             "value_descriptions": {"中立": "尚未建立明确关系"}},
            {"id": "seclusion", "name": "闭关", "type": "flag", "initial": False,
             "value_descriptions": {"false": "尚未闭关", "true": "已经闭关"}},
            {"id": "power", "name": "武力", "type": "scalar",
             "min": 0, "max": 100, "initial": 1},
        ],
        "nodes": [
            {"id": "start", "title": "入门", "type": "mainline"},
            {"id": "master", "title": "见师傅", "type": "mainline", "characters": ["char-1"]},
            {"id": "lib", "title": "藏经阁", "type": "mainline"},
            {"id": "sec", "title": "闭关", "type": "optional"},
            {"id": "end", "title": "出师", "type": "ending"},
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "master",
             "condition": {"var": "seclusion", "op": "==", "value": False}, "label": "见师傅"},
            {"id": "e2", "source": "start", "target": "lib", "label": "先去藏经阁"},
            {"id": "e3", "source": "start", "target": "sec", "label": "闭关"},
            {"id": "e4", "source": "lib", "target": "master"},
            {"id": "e5", "source": "master", "target": "end"},
            {"id": "e6", "source": "sec", "target": "end"},
        ],
    }


def run_check() -> bool:
    """跑一遍事件图校验断言，全过返回 True。"""
    _expect_ok(_valid_graph(), "合法事件图通过")

    # 未声明的状态变量被边条件引用。
    g = _valid_graph()
    g["edges"][0]["condition"]["var"] = "ghost"
    _expect_bad(g, "条件引用未声明变量被拒", "未声明的状态变量")

    # 成环（end 反指回 start）破坏前向 DAG。
    g = _valid_graph()
    g["edges"].append({"id": "loop", "source": "end", "target": "start"})
    _expect_bad(g, "成环被拒", "环")

    # 缺少结局节点。
    g = _valid_graph()
    for n in g["nodes"]:
        if n["type"] == "ending":
            n["type"] = "mainline"
    _expect_bad(g, "缺结局被拒", "结局")

    # 边端点不存在。
    g = _valid_graph()
    g["edges"][0]["target"] = "missing"
    _expect_bad(g, "边端点不存在被拒", "不存在")

    # 自环。
    g = _valid_graph()
    g["edges"].append({"id": "self", "source": "lib", "target": "lib"})
    _expect_bad(g, "自环被拒", "自环")

    # enum 变量 initial 不在取值域 → Pydantic 字段校验。
    g = _valid_graph()
    g["state_variables"][0]["initial"] = "陌生"
    _expect_bad(g, "enum initial 越域被拒", "allowed")

    # 取值说明只能引用对应类型实际存在的值。
    g = _valid_graph()
    g["state_variables"][0]["value_descriptions"]["陌生"] = "无效说明"
    _expect_bad(g, "enum 未知取值说明被拒", "allowed 之外")

    g = _valid_graph()
    g["state_variables"][1]["value_descriptions"]["yes"] = "无效说明"
    _expect_bad(g, "flag 未知取值说明被拒", "true/false")

    g = _valid_graph()
    g["state_variables"][2]["value_descriptions"] = {"0": "零"}
    _expect_bad(g, "scalar 逐值说明被拒", "不应声明")

    g = _valid_graph()
    g["state_variables"][0]["allowed"].append("中立")
    _expect_bad(g, "enum 重复取值被拒", "不能重复")

    # scalar 条件取值越界。
    g = _valid_graph()
    g["edges"][1]["condition"] = {"var": "power", "op": ">=", "value": 999}
    _expect_bad(g, "scalar 条件越界被拒", "max")

    # 节点多余字段（事件层不应有 effects）→ extra=forbid。
    g = _valid_graph()
    g["nodes"][0]["effects"] = [{"var": "power", "op": "add", "value": 1}]
    _expect_bad(g, "节点多余字段被拒", "effects")

    # 硬切换后不再兼容旧到达计划顶层字段。
    g = _valid_graph()
    g["reachability_plan"] = {}
    _expect_bad(g, "旧事件到达计划字段被拒", "reachability_plan")

    return True


def main() -> int:
    """CLI 入口：跑事件图校验断言。"""
    print("── 事件图 schema + 结构校验断言 运行中 ...")
    run_check()
    print("\n==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
