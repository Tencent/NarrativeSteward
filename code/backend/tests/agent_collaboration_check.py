"""主 Agent 跨层任务执行范围协商的提示词契约。

不调用 LLM。见 DESIGN §3.4。

用法::

    python tests/agent_collaboration_check.py
"""

from __future__ import annotations

import sys

from narrative_forge.agents.prompts import MAIN_AGENT_PROMPT


def _expect(condition: bool, message: str) -> None:
    """断言条件成立，否则终止。"""
    if not condition:
        print(f"   FAIL  {message}")
        raise SystemExit(1)
    print(f"   PASS  {message}")


def run_check() -> bool:
    """检查主 Agent 提示词覆盖默认分阶段、一次性授权、单层和只规划。"""
    prompt = MAIN_AGENT_PROMPT
    _expect("跨层任务的执行范围协商" in prompt, "含跨层执行范围协商规则")
    _expect("只完成第一阶段" in prompt, "默认同一回合只完成第一阶段")
    _expect("询问是否继续" in prompt, "第一阶段后询问是否继续")
    _expect(
        "一次性完成" in prompt and "无需逐步确认" in prompt,
        "明确一次性授权可连续执行",
    )
    _expect("只要求单层内容" in prompt, "单层任务不展开全项目规划")
    _expect("不写入" in prompt and "只规划" in prompt, "只规划时不写入项目")
    _expect("当前项目缺口" in prompt, "阶段按项目缺口动态确定")
    _expect("不要固定要求必须经过" in prompt, "不强制固定五阶段")
    _expect("[系统说明]" in prompt and "已被停止" in prompt, "停止后按原请求重做")
    return True


def main() -> int:
    """CLI 入口。"""
    print("── 主 Agent 跨层协作提示词契约 运行中 ...")
    run_check()
    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
