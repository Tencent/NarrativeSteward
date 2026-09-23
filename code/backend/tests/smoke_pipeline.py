"""端到端冒烟测试：大纲 / 世界设定 / 事件图 生成流水线（顺序 意图→大纲→设定→事件）。

验证"无头核心 + 编排层 + Deep Agents"的完整链路在真实 LLM 下可跑通：

- ``outline`` 阶段：主 Agent 读 ``intent.md`` / ``materials/`` → 路由到 ``outline-writer``
  子 Agent → 写 ``outline.md``（自由 Markdown 文本）→ bump revision。
- ``world`` 阶段：主 Agent 读上游 ``outline.md`` → 路由到 ``world-builder`` 子 Agent →
  写 ``world.json``（分类卡片）→ 回合末 Pydantic 校验通过 → bump revision。
- ``events`` 阶段：主 Agent 读上游 ``outline.md`` / ``world.json`` → 路由到 ``event-builder``
  子 Agent → 写 ``events.json``（状态变量 + 节点 + 边）→ 回合末 schema + 图结构校验通过 → bump revision。

各阶段顺序跑可一并验证**子 Agent 切换**与**跨阶段读上游数据**这条关键路径。

⚠️ 本脚本会真实调用 LLM（需 ``code/backend/.env`` 配好凭据），有 token 开销与耗时。

用法::

    # 默认：临时工作区里跑 world + outline 两阶段（结束自动清理）
    python tests/smoke_pipeline.py

    # 只跑某些阶段
    python tests/smoke_pipeline.py --stages world

    # 指定工作区并保留产物（便于人工检查生成结果）
    python tests/smoke_pipeline.py --workspace /tmp/nf_smoke --keep

退出码：全部阶段通过返回 0，否则返回 1（便于脚本/CI 判定）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

from narrative_forge.core.store import DATA_TYPES, TEXT_TYPES, ProjectStore
from narrative_forge.core.validation import validate_data
from narrative_forge.orchestrator import ProjectSession, TurnResult

# 各阶段对应的用户指令（用自然语言，让主 Agent 自行路由 / 落产物）。
_STAGE_PROMPTS: dict[str, str] = {
    "intent": (
        "我想把这篇素材改编成一个赛博朋克 + 悬疑风格的交互叙事，基调冷峻压抑，"
        "并把线性结局改成多结局分支。请把我的创作意图记录下来。"
    ),
    "outline": "请基于我的创作意图与项目素材，生成一份故事大纲。",
    "world": "请基于已有的故事大纲与项目素材，生成完整的世界设定。",
    "events": "请基于已有的故事大纲与世界设定，生成事件图（含全局状态变量、事件节点与带条件的边）。",
}

# 默认按依赖顺序执行（intent → outline → world → events）。
_DEFAULT_STAGES = ["intent", "outline", "world", "events"]


def _check_stage(store: ProjectStore, project_id: str, stage: str, result: TurnResult) -> str | None:
    """校验某阶段产物是否真正生成且合法。

    Args:
        store: 项目存储。
        project_id: 项目 id。
        stage: 阶段名（``world`` / ``outline``）。
        result: 该阶段对话回合的结果。

    Returns:
        失败原因字符串；若通过则返回 ``None``。
    """
    # 1) 编排层应已将该片段登记为"已更新"（= 校验通过并 bump 了 revision）。
    updated_types = {dt for dt, _rev in result.updated}
    if stage not in updated_types:
        if stage in result.failed:
            return f"编排层校验失败：{result.failed[stage]}"
        return "Agent 未写入该片段（updated 中无此类型）"

    # 1.5) 自由文本片段（intent 等）：只检查文件存在且非空，不做 JSON 校验。
    if stage in TEXT_TYPES:
        p = store.text_file(project_id, stage)
        if not p.exists() or not p.read_text("utf-8").strip():
            return f"产物文件不存在或为空：{p}"
        return None

    # 2) 双保险：直接读盘再过一次 Pydantic 校验。
    data_file = store.data_file(project_id, stage)
    if not data_file.exists():
        return f"产物文件不存在：{data_file}"
    try:
        data = json.loads(data_file.read_text("utf-8"))
    except json.JSONDecodeError as exc:
        return f"产物不是合法 JSON：{exc}"
    ok, msg = validate_data(stage, data)
    return None if ok else f"产物未通过 schema 校验：{msg}"


async def run_smoke(workspace: Path, source: Path, stages: list[str]) -> bool:
    """在指定工作区跑一遍冒烟，返回是否全部通过。

    Args:
        workspace: 项目数据工作区目录。
        source: 原始素材文件。
        stages: 要执行的阶段列表（按给定顺序）。

    Returns:
        所有阶段均通过则 ``True``，否则 ``False``。
    """
    store = ProjectStore(workspace)
    meta = store.create_project("冒烟测试")
    store.add_material(meta.id, source.name, source.read_text("utf-8"))
    print(f"工作区: {workspace}")
    print(f"项目:   {meta.id}")
    print(f"阶段:   {' -> '.join(stages)}\n")

    session = ProjectSession(store, meta.id)

    all_passed = True
    for stage in stages:
        print(f"── 阶段 [{stage}] 运行中 ...")
        result = await session.asend(_STAGE_PROMPTS[stage])
        err = _check_stage(store, meta.id, stage, result)
        if err is None:
            rev = next(r for dt, r in result.updated if dt == stage)
            extra = f"（自动修复 {result.repairs} 次）" if result.repairs else ""
            fname = f"{stage}.json" if stage in DATA_TYPES else store.text_file(meta.id, stage).name
            print(f"   PASS  {fname} 已生成并校验通过，revision={rev} {extra}\n")
        else:
            all_passed = False
            print(f"   FAIL  {stage}：{err}\n")

    return all_passed


def main(argv: list[str] | None = None) -> int:
    """CLI 主入口：解析参数、跑冒烟、按结果返回退出码。"""
    parser = argparse.ArgumentParser(description="世界设定/大纲 生成流水线端到端冒烟测试")
    default_source = Path(__file__).parent / "fixtures" / "sample_source.txt"
    parser.add_argument(
        "--stages",
        default=",".join(_DEFAULT_STAGES),
        help=f"逗号分隔的阶段（默认 {','.join(_DEFAULT_STAGES)}）",
    )
    parser.add_argument(
        "--source", default=str(default_source), help="原始素材文件路径"
    )
    parser.add_argument(
        "--workspace", default=None, help="工作区目录（默认用临时目录，结束后清理）"
    )
    parser.add_argument(
        "--keep", action="store_true", help="保留工作区产物（仅在使用临时目录时有意义）"
    )
    args = parser.parse_args(argv)

    stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    unknown = [s for s in stages if s not in _STAGE_PROMPTS]
    if unknown:
        print(f"未知阶段: {unknown}；可选: {list(_STAGE_PROMPTS)}")
        return 2

    source = Path(args.source)
    if not source.exists():
        print(f"素材文件不存在: {source}")
        return 2

    use_temp = args.workspace is None
    workspace = Path(args.workspace) if args.workspace else Path(tempfile.mkdtemp(prefix="nf_smoke_"))

    try:
        passed = asyncio.run(run_smoke(workspace, source, stages))
    finally:
        if use_temp and not args.keep:
            shutil.rmtree(workspace, ignore_errors=True)
            print(f"（已清理临时工作区 {workspace}）")

    print("\n==== 结果 ====")
    print("全部通过 ✅" if passed else "存在失败 ❌")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
