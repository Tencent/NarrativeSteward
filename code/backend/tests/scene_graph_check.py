"""离线单测：场景/情节图 schema + 图结构 + effect/condition 引用校验（见 DESIGN §4.2 场景层）。

不调用 LLM，纯用 :func:`validate_scene` 验证阶段 4 契约：

- 合法情节图（beat/边结构合法、前向 DAG、有终止 beat 且可达、effect/condition 引用合法）通过；
- 各类非法情形（引用未声明变量、op 与类型不匹配、set 越界、成环、无终止 beat、
  端点不存在、自环、beat 多余字段等）被拒绝并给出可读原因。

场景图的 effect/condition 引用的状态变量在事件层声明，故本测试自带一份状态变量声明传入。

用法::

    PYTHONPATH=. python tests/scene_graph_check.py

退出码：全部断言通过返回 0，否则返回 1。
"""

from __future__ import annotations

import sys

from narrative_forge.core.validation import validate_scene

# 事件层声明的状态变量（供场景图 effect/condition 引用）。
_STATE_VARS = [
    {"id": "rel", "name": "与师傅关系", "type": "enum", "allowed": ["敌对", "盟友"], "initial": "敌对"},
    {"id": "seclusion", "name": "闭关", "type": "flag", "initial": False},
    {"id": "power", "name": "武力", "type": "scalar", "min": 0, "max": 100, "initial": 1},
]
# 世界设定的地点卡片（供场景图 beat.location 硬引用校验，见 DESIGN §5.8(b)）。
_WORLD_LOCATIONS = [
    {"id": "loc-1", "name": "静室"},
    {"id": "loc-2", "name": "后山"},
]
_WORLD = {
    "worldview": [],
    "characters": [{"id": "char-1", "name": "弟子", "description": "", "tags": [], "image": ""}],
    "locations": _WORLD_LOCATIONS,
    "factions": [],
    "history": [],
    "other": [],
}


def _fail(msg: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {msg}")
    raise SystemExit(1)


def _expect_ok(data: dict, label: str, world_data: dict | None = None) -> None:
    """断言情节图合法。"""
    ok, msg = validate_scene(data, _STATE_VARS, _WORLD_LOCATIONS, world_data=world_data)
    if not ok:
        _fail(f"{label} 应合法，却被拒：{msg}")
    print(f"   PASS  {label}")


def _expect_bad(data: dict, label: str, needle: str, world_data: dict | None = None) -> None:
    """断言情节图非法，且错误信息包含 ``needle``。"""
    ok, msg = validate_scene(data, _STATE_VARS, _WORLD_LOCATIONS, world_data=world_data)
    if ok:
        _fail(f"{label} 应被拒，却通过了")
    if needle not in msg:
        _fail(f"{label} 的报错应含『{needle}』，实际：{msg}")
    print(f"   PASS  {label}")


def _valid_scene() -> dict:
    """一张合法的样例情节图（选择点分支后汇合到收尾 beat，含 set/add 两类写入）。

    每个 beat 都绑定了 ``location``（引用 :data:`_WORLD_LOCATIONS` 里已存在的地点卡片 id）。
    """
    return {
        "event_id": "ev-master",
        "beats": [
            {"id": "b-open", "kind": "narration", "location": "loc-1", "content": "走进静室。", "effects": []},
            {"id": "b-choice", "kind": "choice", "location": "loc-1", "content": "师傅相问。", "effects": []},
            {"id": "b-humble", "kind": "dialogue", "speaker": "char-1", "location": "loc-1", "content": "恭敬求教。",
             "effects": [{"var": "rel", "op": "set", "value": "盟友"}]},
            {"id": "b-arrogant", "kind": "dialogue", "speaker": "char-1", "location": "loc-1", "content": "出言不逊。",
             "effects": [{"var": "rel", "op": "set", "value": "敌对"}]},
            {"id": "b-end", "kind": "narration", "location": "loc-2", "content": "会面结束。",
             "effects": [{"var": "power", "op": "add", "value": 5}, {"var": "seclusion", "op": "set", "value": True}]},
        ],
        "edges": [
            {"id": "s1", "source": "b-open", "target": "b-choice", "label": ""},
            {"id": "s2", "source": "b-choice", "target": "b-humble", "label": "谦逊"},
            {"id": "s3", "source": "b-choice", "target": "b-arrogant", "label": "桀骜"},
            {"id": "s4", "source": "b-humble", "target": "b-end",
             "condition": {"var": "rel", "op": "==", "value": "盟友"}},
            {"id": "s5", "source": "b-arrogant", "target": "b-end"},
        ],
    }


def run_check() -> bool:
    """跑一遍情节图校验断言，全过返回 True。"""
    _expect_ok(_valid_scene(), "合法情节图通过")

    # effect 引用未声明变量。
    g = _valid_scene()
    g["beats"][2]["effects"][0]["var"] = "ghost"
    _expect_bad(g, "effect 引用未声明变量被拒", "未声明的状态变量")

    # op=add 用于非 scalar 变量。
    g = _valid_scene()
    g["beats"][2]["effects"][0]["op"] = "add"
    _expect_bad(g, "add 用于 enum 被拒", "add 仅适用于 scalar")

    # set 值越界（scalar）。
    g = _valid_scene()
    g["beats"][4]["effects"][0] = {"var": "power", "op": "set", "value": 999}
    _expect_bad(g, "scalar set 越界被拒", "max")

    # enum set 值不在 allowed。
    g = _valid_scene()
    g["beats"][2]["effects"][0]["value"] = "陌生"
    _expect_bad(g, "enum set 越域被拒", "allowed")

    # 成环破坏前向 DAG。
    g = _valid_scene()
    g["edges"].append({"id": "loop", "source": "b-end", "target": "b-open"})
    _expect_bad(g, "成环被拒", "环")

    # 多个入口 beat（入度=0）→ 单起点硬校验拒绝（DESIGN §4.2(c)/§4.5）。
    g = _valid_scene()
    g["beats"].append({"id": "b-extra", "kind": "narration", "location": "loc-1", "content": "另一个开头。", "effects": []})
    g["edges"].append({"id": "s6", "source": "b-extra", "target": "b-end"})
    _expect_bad(g, "多入口 beat 被拒", "多个入口 beat")

    # 无终止 beat（每个 beat 都有出边，互相成环 → 既报环也报无终止 beat）。
    g2 = {
        "event_id": "ev",
        "beats": [{"id": "a", "kind": "narration", "effects": []}, {"id": "b", "kind": "narration", "effects": []}],
        "edges": [{"id": "e1", "source": "a", "target": "b"}, {"id": "e2", "source": "b", "target": "a"}],
    }
    _expect_bad(g2, "无终止 beat 被拒", "终止")

    # 边端点不存在。
    g = _valid_scene()
    g["edges"][0]["target"] = "missing"
    _expect_bad(g, "边端点不存在被拒", "不存在")

    # 自环。
    g = _valid_scene()
    g["edges"].append({"id": "self", "source": "b-open", "target": "b-open"})
    _expect_bad(g, "自环被拒", "自环")

    # beat 多余字段 → extra=forbid。
    g = _valid_scene()
    g["beats"][0]["type"] = "narration"
    _expect_bad(g, "beat 多余字段被拒", "type")

    # 边条件引用未声明变量。
    g = _valid_scene()
    g["edges"][3]["condition"] = {"var": "ghost", "op": "==", "value": 1}
    _expect_bad(g, "边条件引用未声明变量被拒", "未声明的状态变量")

    # beat 缺少地点 location。
    g = _valid_scene()
    del g["beats"][0]["location"]
    _expect_bad(g, "beat 缺少 location 被拒", "缺少地点 location")

    # beat 地点引用世界设定不存在的地点。
    g = _valid_scene()
    g["beats"][0]["location"] = "loc-ghost"
    _expect_bad(g, "beat location 引用不存在地点被拒", "不存在的地点")

    # 硬切换后不再兼容旧到达计划顶层字段。
    g = _valid_scene()
    g["reachability_plan"] = {}
    _expect_bad(g, "旧 scene 到达计划字段被拒", "reachability_plan")

    # 未知或自由名称 speaker 阻断保存。
    g = _valid_scene()
    g["beats"][2]["speaker"] = "oth-missing"
    _expect_bad(g, "未知卡片 id speaker 被拒", "oth-missing", world_data=_WORLD)
    g = _valid_scene()
    g["beats"][2]["speaker"] = "堂叔"
    _expect_bad(g, "自由名称 speaker 被拒", "堂叔", world_data=_WORLD)
    _expect_ok(_valid_scene(), "已知卡片 id speaker 可通过", world_data=_WORLD)

    return True


def main() -> int:
    """CLI 入口：跑情节图校验断言。"""
    print("── 场景/情节图 schema + 结构 + 引用校验断言 运行中 ...")
    run_check()
    print("\n==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
