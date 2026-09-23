"""项目级正式联合状态检测服务。

REST、CLI 与 Agent 工具统一调用本模块。调用方负责项目 ``busy`` 生命周期；本服务只读取一次固定
内容快照、执行可取消的完整检测，并在成功完成后原子保存正式报告。
"""

from __future__ import annotations

import os
import resource
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from narrative_forge.core.store import ProjectStore
from narrative_forge.core.validation import state_validation_report

ProgressCallback = Callable[[dict[str, Any]], None]


class StateValidationCancelled(RuntimeError):
    """用户请求取消正式检测。"""


class StateValidationResourceStop(RuntimeError):
    """检测达到进程安全内存线，未形成业务结论。"""


def _cgroup_memory_limit_bytes() -> int | None:
    """读取当前进程的有限 cgroup 内存上限。"""
    for path in (
        Path("/sys/fs/cgroup/memory.max"),
        Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    ):
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            value = int(raw)
        except ValueError:
            continue
        if 0 < value < 1 << 60:
            return value
    return None


def _current_rss_bytes() -> int:
    """返回当前进程常驻内存；无法读取时退化为 Linux 历史峰值。"""
    try:
        fields = Path("/proc/self/statm").read_text(encoding="utf-8").split()
        return int(fields[1]) * int(os.sysconf("SC_PAGE_SIZE"))
    except (OSError, IndexError, ValueError):
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def run_state_validation_for_project(
    store: ProjectStore,
    project_id: str,
    *,
    persist: bool = True,
    cancel_event: threading.Event | None = None,
    progress_callback: ProgressCallback | None = None,
    progress_every: int = 50_000,
    memory_stop_ratio: float = 0.85,
) -> dict[str, Any]:
    """对项目固定快照运行正式联合状态检测。

    Args:
        store: 项目存储。
        project_id: 待检测项目 id。
        persist: 是否原子保存到 ``validation/latest.json``。
        cancel_event: 由运行器设置的线程安全取消标志。
        progress_callback: 接收阶段、传播统计、耗时和内存的回调。
        progress_every: 每处理多少个紧凑状态上报一次传播进度。
        memory_stop_ratio: 当前进程 RSS 达到 cgroup 上限的该比例时安全停止。

    Returns:
        包含 ``saved/status/current_fingerprint/checked_at/report/message`` 的结果。

    Raises:
        StateValidationCancelled: 用户请求取消。
        StateValidationResourceStop: 当前进程达到安全内存线。
    """
    started = time.perf_counter()
    cancel = cancel_event or threading.Event()
    memory_limit = _cgroup_memory_limit_bytes()
    memory_stop_bytes = (
        int(memory_limit * memory_stop_ratio)
        if memory_limit is not None
        else None
    )
    peak_rss = _current_rss_bytes()

    def check_resources() -> None:
        """在传播与路线还原的安全点检查取消和内存。"""
        nonlocal peak_rss
        if cancel.is_set():
            raise StateValidationCancelled("检测已由用户取消")
        current_rss = _current_rss_bytes()
        peak_rss = max(peak_rss, current_rss)
        if memory_stop_bytes is not None and current_rss >= memory_stop_bytes:
            raise StateValidationResourceStop(
                "检测已在系统内存耗尽前安全停止；本次未产生业务结论"
            )

    def emit(progress: dict[str, Any]) -> None:
        """补充产品生命周期指标后上报传播进度。"""
        check_resources()
        if progress_callback is not None:
            progress_callback(
                {
                    "phase": "propagating",
                    **progress,
                    "peak_memory_bytes": peak_rss,
                    "memory_limit_bytes": memory_limit,
                    "memory_stop_bytes": memory_stop_bytes,
                }
            )

    check_resources()
    snapshot = store.load_validation_snapshot(project_id)
    if progress_callback is not None:
        progress_callback(
            {
                "phase": "preflight",
                "configs_explored": 0,
                "configs_discovered": 0,
                "positions_reached": 0,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
                "peak_memory_bytes": peak_rss,
                "memory_limit_bytes": memory_limit,
                "memory_stop_bytes": memory_stop_bytes,
                "complete": False,
            }
        )

    world_raw = snapshot.get("world")
    report = state_validation_report(
        snapshot["events"],
        snapshot["scenes"],
        invalid_scene_ids=snapshot["invalid_scene_ids"],
        world_data=world_raw if isinstance(world_raw, dict) else {},
        progress_callback=emit,
        progress_every=progress_every,
        cancel_check=check_resources,
    )
    check_resources()
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    report.setdefault("meta", {})
    report["meta"]["elapsed_ms"] = elapsed_ms
    report["meta"]["peak_memory_bytes"] = peak_rss
    report["meta"]["memory_limit_bytes"] = memory_limit
    report["meta"]["memory_stop_bytes"] = memory_stop_bytes

    input_fingerprint = snapshot["fingerprint"]
    if not persist:
        return {
            "saved": False,
            "status": report["status"],
            "current_fingerprint": input_fingerprint["digest"],
            "checked_at": None,
            "report": report,
            "message": None,
        }

    store.save_validation_record(
        project_id,
        fingerprint=input_fingerprint,
        report=report,
    )
    state = store.validation_state(project_id)
    return {
        "saved": True,
        **state,
        "message": None,
    }
