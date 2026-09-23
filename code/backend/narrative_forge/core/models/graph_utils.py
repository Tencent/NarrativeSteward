"""有向图的通用结构算法（事件层 / 场景层共用）。

事件图与场景图都建在同一套图原语上（见 DESIGN §4.2(0)），两者的**结构性校验**都要
做"无环判定"与"忽略条件的纯拓扑可达性"。这两个算法只依赖节点 id 与边的
``source``/``target``，与具体节点/边的业务字段无关，故抽到本模块由两层复用。

约定：传入的 ``edges`` 只要求具备字符串属性 ``source`` / ``target``（鸭子类型），
端点不在 ``node_ids`` 中的边一律忽略。
"""

from __future__ import annotations

from typing import Protocol


class _HasEndpoints(Protocol):
    """任何"有 source/target 两个端点 id"的边（事件边 / 场景边均满足）。"""

    source: str
    target: str


def has_cycle(node_ids: list[str], edges: list[_HasEndpoints]) -> bool:
    """判断有向图是否存在环（DFS 三色标记）。仅考虑端点均合法的边。

    Args:
        node_ids: 全部节点 id。
        edges: 全部边（仅用 ``source``/``target``）；端点不在 ``node_ids`` 中的边被忽略。

    Returns:
        存在环返回 ``True``，否则 ``False``。
    """
    valid = set(node_ids)
    adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
    for e in edges:
        if e.source in valid and e.target in valid:
            adj[e.source].append(e.target)

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {nid: WHITE for nid in node_ids}

    def dfs(u: str) -> bool:
        color[u] = GRAY
        for v in adj[u]:
            if color[v] == GRAY:
                return True
            if color[v] == WHITE and dfs(v):
                return True
        color[u] = BLACK
        return False

    return any(color[nid] == WHITE and dfs(nid) for nid in node_ids)


def reachable_ignoring_conditions(
    node_ids: list[str], edges: list[_HasEndpoints]
) -> set[str]:
    """计算"纯拓扑可达"的节点集合——只看边的连通性，**完全忽略边上的条件**。

    用于结构断链/孤岛检测（如某结局/终止节点没有任何入边）。因为只做图遍历、不看
    条件，所以**不依赖状态变量取值**即可计算；这是个**弱命题**（"忽略条件时存在一条
    边路径"，不代表玩家受条件约束下一定走得到，那属于阶段 4 的可达性软校验）。

    Args:
        node_ids: 全部节点 id（按出现顺序）。
        edges: 全部边；端点不在 ``node_ids`` 中的边会被忽略。

    Returns:
        从"入口节点"（入度为 0）出发可达的节点 id 集合。若不存在入度为 0 的入口
        （通常意味着有环），退化为以全部节点为起点，避免可达性判定被环的噪声淹没。
    """
    valid = set(node_ids)
    adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
    indeg: dict[str, int] = {nid: 0 for nid in node_ids}
    for e in edges:
        if e.source in valid and e.target in valid:
            adj[e.source].append(e.target)
            indeg[e.target] += 1

    entries = [nid for nid in node_ids if indeg[nid] == 0] or list(node_ids)
    seen: set[str] = set()
    stack = list(entries)
    while stack:
        u = stack.pop()
        if u in seen:
            continue
        seen.add(u)
        stack.extend(adj[u])
    return seen
