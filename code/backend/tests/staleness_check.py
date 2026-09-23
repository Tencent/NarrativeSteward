"""离线单测：旧版 staleness 元数据兼容（见 DESIGN §4.10）。

不调用 LLM、不读真实素材，纯用 :class:`ProjectStore` 验证：

- 旧项目 ``based_on/scene_based_on`` 字段仍可反序列化；
- revision 推进不再更新历史依赖基线；
- 存储层不再提供产品级 staleness 推断接口。

用法::

    python tests/staleness_check.py

退出码：全部断言通过返回 0，否则返回 1。
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from narrative_forge.agents.prompts import MAIN_AGENT_PROMPT
from narrative_forge.core.models import ProjectMeta
from narrative_forge.core.store import ProjectStore
from narrative_forge.orchestrator.session import ProjectSession


def _fail(msg: str) -> None:
    """打印失败信息并以非零码退出。"""
    print(f"   FAIL  {msg}")
    raise SystemExit(1)


def _expect(cond: bool, msg: str) -> None:
    """断言 ``cond`` 为真，否则报错退出。"""
    if not cond:
        _fail(msg)


def run_check(workspace: Path) -> bool:
    """验证旧依赖基线只兼容读取、不会继续参与产品逻辑。"""
    store = ProjectStore(workspace)
    meta = store.create_project("旧基线兼容测试")
    pid = meta.id

    legacy = ProjectMeta.model_validate(
        {
            **meta.model_dump(),
            "based_on": {"world": {"intent": 3}},
            "scene_based_on": {"ev-001": {"events": 7}},
        }
    )
    store._write_meta(legacy)
    loaded = store.load_meta(pid)
    _expect(loaded.based_on == {"world": {"intent": 3}}, "应兼容读取旧 based_on")
    _expect(
        loaded.scene_based_on == {"ev-001": {"events": 7}},
        "应兼容读取旧 scene_based_on",
    )

    store.bump_revision(pid, "world")
    store.bump_scene_revision(pid, "ev-001")
    updated = store.load_meta(pid)
    _expect(updated.based_on == loaded.based_on, "推进 revision 不应更新旧 based_on")
    _expect(
        updated.scene_based_on == loaded.scene_based_on,
        "推进 scene revision 不应更新旧 scene_based_on",
    )
    _expect(not hasattr(store, "stale_status"), "存储层不应继续暴露 stale_status")
    _expect(
        not hasattr(store, "scene_stale_status"),
        "存储层不应继续暴露 scene_stale_status",
    )
    session = ProjectSession(store, pid, agent=object())
    _expect(
        session._build_status_note() is None,
        "旧依赖基线不应再生成 Agent 系统状态提醒",
    )
    _expect("影响检查：" in MAIN_AGENT_PROMPT, "主 Agent prompt 应要求修改后影响报告")
    _expect(
        "默认只读取、分析和报告" in MAIN_AGENT_PROMPT,
        "主动一致性检查应默认只读",
    )

    return True


def main() -> int:
    """CLI 入口：临时工作区跑断言，结束清理。"""
    workspace = Path(tempfile.mkdtemp(prefix="nf_stale_"))
    print("── 旧 staleness 元数据兼容断言 运行中 ...")
    try:
        run_check(workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    print("   PASS  旧 staleness 元数据兼容断言全部通过\n")
    print("==== 结果 ====")
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
