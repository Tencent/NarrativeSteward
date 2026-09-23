"""命令行聊天入口：直接驱动核心 + 编排 + Agent，不经过 API（验证"无头核心可脚本化"）。

用法示例::

    # 列出项目
    python -m cli.chat --list

    # 新建项目并导入素材，然后进入交互对话
    python -m cli.chat --new "我的武侠游戏" --load-source ./novel.txt

    # 打开已有项目，发送单条消息（便于脚本/冒烟测试）
    python -m cli.chat --project <id> --message "根据素材生成世界设定"

    # 打开已有项目进入交互对话
    python -m cli.chat --project <id>
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from narrative_forge import config
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator import ProjectSession, TurnResult


def _print_projects(store: ProjectStore) -> None:
    """打印工作区内所有项目。"""
    projects = store.list_projects()
    if not projects:
        print("（工作区暂无项目）")
        return
    print("现有项目：")
    for m in projects:
        stages = ", ".join(f"{k}:{v}" for k, v in m.stages.items())
        print(f"  - {m.id}  「{m.name}」  [{stages}]")


def _print_turn(result: TurnResult) -> None:
    """打印一个回合的结果：助手回复 + 数据更新/校验情况。"""
    print(f"\n助手> {result.text}\n")
    for dt, rev in result.updated:
        print(f"  [已更新] {dt}.json (revision={rev})")
    for dt, err in result.failed.items():
        print(f"  [校验失败] {dt}.json —— 已保留上一版，可重试。原因：\n{err}")
    if result.repairs:
        print(f"  （本回合自动修复 {result.repairs} 次）")


def main(argv: list[str] | None = None) -> int:
    """CLI 主入口。"""
    parser = argparse.ArgumentParser(description="交互叙事游戏创作助手 - 命令行")
    parser.add_argument("--list", action="store_true", help="列出所有项目后退出")
    parser.add_argument("--new", metavar="NAME", help="新建项目（指定名称）")
    parser.add_argument("--project", metavar="ID", help="打开已有项目 id")
    parser.add_argument("--load-source", metavar="FILE", help="把文件内容导入为项目原始素材")
    parser.add_argument("--message", metavar="TEXT", help="发送单条消息后退出（非交互）")
    parser.add_argument("--no-skills", action="store_true", help="禁用 sub-agent 的 skills（排查用）")
    args = parser.parse_args(argv)

    store = ProjectStore(config.get_workspace())
    print(f"工作区: {store.workspace}")

    if args.list:
        _print_projects(store)
        return 0

    # 确定操作的项目
    if args.new:
        meta = store.create_project(args.new)
        print(f"已创建项目: {meta.id} 「{meta.name}」")
        project_id = meta.id
    elif args.project:
        if not store.exists(args.project):
            print(f"项目不存在: {args.project}")
            _print_projects(store)
            return 1
        project_id = args.project
    else:
        _print_projects(store)
        print("\n请用 --new 新建或 --project <id> 打开一个项目。")
        return 1

    # 可选：导入原始素材（存入项目素材库 materials/）
    if args.load_source:
        src = Path(args.load_source)
        if not src.exists():
            print(f"素材文件不存在: {src}")
            return 1
        text = src.read_text("utf-8")
        try:
            name = store.add_material(project_id, src.name, text)
        except ValueError as exc:
            print(f"素材导入失败：{exc}")
            return 1
        print(f"已导入素材 {name}（{len(text)} 字）。")

    # 构建项目会话（内部构建主 Agent + 各 sub-agent，绑定该项目）
    print("正在初始化项目会话 ...")
    session = ProjectSession(store, project_id, use_skills=not args.no_skills)
    print("就绪。\n")

    # 单条消息模式（脚本/冒烟测试）
    if args.message:
        _print_turn(asyncio.run(session.asend(args.message)))
        return 0

    # 交互模式
    return asyncio.run(_interactive(session))


async def _interactive(session: ProjectSession) -> int:
    """交互对话循环（异步）：阻塞的 ``input`` 放到线程，回合走 ``asend``。"""
    print("进入对话（输入 exit / quit 退出）。")
    while True:
        try:
            user_text = (await asyncio.to_thread(input, "你> ")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_text:
            continue
        if user_text.lower() in {"exit", "quit"}:
            break
        _print_turn(await session.asend(user_text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
