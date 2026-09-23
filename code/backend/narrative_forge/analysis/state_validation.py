"""完整联合状态检测的命令行入口。

用法（在 ``code/backend`` 下）::

    PYTHONPATH=. python -m narrative_forge.analysis.state_validation <project_id>

命令与产品 API 使用同一个检测核心，并把结果绑定到当前事件/情节内容指纹。
"""

from __future__ import annotations

import argparse
import sys

from narrative_forge.config import get_workspace
from narrative_forge.core.state_validation_service import (
    run_state_validation_for_project,
)
from narrative_forge.core.store import ProjectStore


def _print_report(project_id: str, report: dict) -> None:
    """打印状态、节点覆盖和前若干个具体问题。

    Args:
        project_id: 被检测项目 id。
        report: 正式联合状态检测报告。
    """
    summary = report["summary"]
    print(f"── 完整可玩性检测：{project_id}")
    print(f"  状态：{report['status']}")
    print(
        "  事件："
        f"{summary.get('events_reached', 0)}/{summary.get('events_total', 0)} · "
        "情节节点："
        f"{summary.get('beats_reached', 0)}/{summary.get('beats_total', 0)} · "
        "已处理状态："
        f"{summary.get('states_explored', 0)}"
    )
    for item in report.get("issues", [])[:20]:
        print(f"  - {item['message']}")
    if len(report.get("issues", [])) > 20:
        print(f"  - ……另有 {len(report['issues']) - 20} 项")
    print(f"  耗时：{report['meta']['elapsed_ms']} ms")


def main(argv: list[str] | None = None) -> int:
    """读取项目、从头检测并保存与内容指纹绑定的记录。

    Args:
        argv: 可选命令行参数，主要供离线测试注入。

    Returns:
        ``0`` 表示通过，``1`` 表示项目不存在，``2`` 表示未保存，``3`` 表示业务未通过。
    """
    parser = argparse.ArgumentParser(description="传播项目的全部有限联合状态")
    parser.add_argument("project_id", help="项目 id（workspace/projects/<id>）")
    args = parser.parse_args(argv)

    store = ProjectStore(get_workspace())
    if not store.exists(args.project_id):
        print(f"项目不存在：{args.project_id}", file=sys.stderr)
        return 1

    result = run_state_validation_for_project(store, args.project_id)
    report = result["report"]
    _print_report(args.project_id, report)
    if not result["saved"]:
        print(result["message"] or "本次结果未保存。", file=sys.stderr)
        return 2

    print(f"  检测记录：{store.validation_file(args.project_id)}")
    print(f"  内容编号：{result['current_fingerprint'][:12]}")
    return 0 if report["status"] == "passed" else 3


if __name__ == "__main__":
    sys.exit(main())
