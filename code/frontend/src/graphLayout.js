import dagre from 'dagre'

/**
 * 事件网络与情节网络共用的前向布局。
 *
 * 流水线：全局定列 → 从左到右一次落位节点和出边标签 → 跨列通道占用 → 最后走线。
 * 坐标只在前端使用，不写回项目文件。
 */

/** 边标签最大宽度（px），须与 `.graph-edge-label { max-width }` 保持一致。 */
export const GRAPH_EDGE_LABEL_MAX_WIDTH = 136

/**
 * 两行标签的最大高度（px）：10px 字号 × 1.3 行高 × 2 行 + 内边距与边框。
 * 布局按此占位，短文案仍占用同样槽位，避免量字回排。
 */
export const GRAPH_EDGE_LABEL_MAX_HEIGHT = 36

/** 标签底边相对走线的间隙，须与 GraphChoiceEdge 回退路径一致。 */
export const GRAPH_EDGE_LABEL_OFFSET_Y = 8

/** 相邻标签槽之间的垂直间隙。 */
export const GRAPH_LABEL_SLOT_GAP = 10

/** 节点/标签/通道之间的避让间隙。 */
export const GRAPH_BOX_GAP = 8

/** 节点右侧出线与目标左侧入线的短走线道宽度；标签框水平居中后，走廊两侧至少留出这段距离。 */
export const GRAPH_WIRE_LANE = 18

/** 选项框外上下转向与边框的水平间隙；垂直段不得与左/右边框共线。 */
export const GRAPH_LABEL_ROUTE_GAP = 12

/**
 * 两列之间的走廊宽度：至少放下选项框、左右转向缓冲和两侧短走线道。
 *
 * @param {number} ranksep 布局要求的列间距。
 * @returns {number}
 */
export function graphColumnGap(ranksep) {
  return Math.max(
    ranksep,
    GRAPH_EDGE_LABEL_MAX_WIDTH + GRAPH_LABEL_ROUTE_GAP * 2 + GRAPH_WIRE_LANE * 2,
  )
}

/** 同一节点多条出/入边的旧式控制点间距；仅保留给回退贝塞尔路径。 */
export const GRAPH_PARALLEL_EDGE_GAP = 96

/** 反向边在图上方的通道间距。 */
export const GRAPH_BACK_EDGE_GAP = 28

/**
 * 一对起止节点的稳定键，用于把平行边收成一组。
 *
 * @param {string|undefined} source 起点 id。
 * @param {string|undefined} target 终点 id。
 * @returns {string}
 */
export function graphPairKey(source, target) {
  return `${source || ''}->${target || ''}`
}

/**
 * 布局与渲染共用的边稳定键：优先边 id，否则起止对。
 *
 * @param {{id?: string, source?: string, target?: string}} edge
 * @param {number} [index] 无 id 时的次序，避免平行边撞键。
 * @returns {string}
 */
export function edgeLayoutKey(edge, index = 0) {
  return edge?.id || `${edge?.source || ''}->${edge?.target || ''}#${index}`
}

/**
 * 计算平行边相对中线的垂直错开量。一条边为 0；多条边以中线对称展开。
 * 仅用于回退贝塞尔路径。
 *
 * @param {number} index 该边在组内的序号，从 0 开始。
 * @param {number} count 同组边数。
 * @param {number} [gap] 相邻间距。
 * @returns {number}
 */
export function parallelEdgeOffsetY(index, count, gap = GRAPH_PARALLEL_EDGE_GAP) {
  if (count <= 1) return 0
  return (index - (count - 1) / 2) * gap
}

/**
 * 轴对齐矩形是否重叠。pad 为正时要求额外空隙。
 *
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @param {number} [pad]
 * @returns {boolean}
 */
export function rectsOverlap(a, b, pad = 0) {
  if (!a || !b) return false
  return !(
    a.x + a.width + pad <= b.x
    || b.x + b.width + pad <= a.x
    || a.y + a.height + pad <= b.y
    || b.y + b.height + pad <= a.y
  )
}

/**
 * 把 Y 起点向下推过所有占用带，保证 [y, y+height] 不与任何带相交。
 *
 * @param {number} y 期望的上沿。
 * @param {number} height 高度。
 * @param {Array<{y:number,height:number}>} bands 已占用的垂直带。
 * @param {number} [gap] 与占用带的最小间隙。
 * @returns {number} 可用的上沿。
 */
export function pushPastBands(y, height, bands, gap = GRAPH_BOX_GAP) {
  const sorted = [...(bands || [])].sort((left, right) => left.y - right.y)
  let current = y
  let changed = true
  while (changed) {
    changed = false
    for (const band of sorted) {
      const overlaps = current < band.y + band.height + gap
        && current + height + gap > band.y
      if (overlaps) {
        current = band.y + band.height + gap
        changed = true
      }
    }
  }
  return current
}

/**
 * 由正交折点生成带圆角的 SVG 路径。共线折点会被合并。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} [radius] 转角半径。
 * @returns {string}
 */
export function roundedOrthogonalPath(points, radius = 10) {
  const cleaned = collapseCollinearPoints(points || [])
  if (cleaned.length === 0) return ''
  if (cleaned.length === 1) return `M ${cleaned[0].x} ${cleaned[0].y}`
  if (cleaned.length === 2) {
    return `M ${cleaned[0].x} ${cleaned[0].y} L ${cleaned[1].x} ${cleaned[1].y}`
  }
  let d = `M ${cleaned[0].x} ${cleaned[0].y}`
  for (let index = 1; index < cleaned.length; index += 1) {
    const prev = cleaned[index - 1]
    const curr = cleaned[index]
    const next = cleaned[index + 1]
    if (!next) {
      d += ` L ${curr.x} ${curr.y}`
      break
    }
    const dx1 = curr.x - prev.x
    const dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x
    const dy2 = next.y - curr.y
    const len1 = Math.hypot(dx1, dy1)
    const len2 = Math.hypot(dx2, dy2)
    const corner = Math.min(radius, len1 / 2, len2 / 2)
    if (corner < 1) {
      d += ` L ${curr.x} ${curr.y}`
      continue
    }
    const x1 = curr.x - (dx1 / len1) * corner
    const y1 = curr.y - (dy1 / len1) * corner
    const x2 = curr.x + (dx2 / len2) * corner
    const y2 = curr.y + (dy2 / len2) * corner
    d += ` L ${x1} ${y1} Q ${curr.x} ${curr.y} ${x2} ${y2}`
  }
  return d
}

/**
 * 用 React Flow 实测连接点替换预计算路径的端点，保证出边/入边仍钉在 Handle 上。
 *
 * @param {Array<{x:number,y:number}>|undefined} points 预计算折点。
 * @param {number} sourceX
 * @param {number} sourceY
 * @param {number} targetX
 * @param {number} targetY
 * @returns {Array<{x:number,y:number}>}
 */
export function applyRouteHandles(points, sourceX, sourceY, targetX, targetY) {
  const start = { x: sourceX, y: sourceY }
  const end = { x: targetX, y: targetY }
  if (!points || points.length < 2) return [start, end]
  const middle = points.slice(1, -1)
  return [start, ...middle, end]
}

/**
 * 去掉相邻重复点与共线中间点，避免零长度圆角。
 *
 * @param {Array<{x:number,y:number}>} points
 * @returns {Array<{x:number,y:number}>}
 */
export function collapseCollinearPoints(points) {
  const unique = []
  for (const point of points || []) {
    const prev = unique[unique.length - 1]
    if (prev && prev.x === point.x && prev.y === point.y) continue
    unique.push(point)
  }
  if (unique.length < 3) return unique
  const collapsed = [unique[0]]
  for (let index = 1; index < unique.length - 1; index += 1) {
    const prev = collapsed[collapsed.length - 1]
    const curr = unique[index]
    const next = unique[index + 1]
    const collinear = (prev.x === curr.x && curr.x === next.x)
      || (prev.y === curr.y && curr.y === next.y)
    if (!collinear) collapsed.push(curr)
  }
  collapsed.push(unique[unique.length - 1])
  return collapsed
}

/**
 * 与 React Flow 默认贝塞尔相同的控制点外伸距离。
 *
 * @param {number} distance 沿连接方向的间距。
 * @param {number} [curvature] 反向时的弯曲系数。
 * @returns {number}
 */
function bezierControlOffset(distance, curvature = 0.25) {
  if (distance >= 0) return 0.5 * distance
  return curvature * 25 * Math.sqrt(-distance)
}

/**
 * 按连接点朝向计算贝塞尔控制点。
 *
 * @param {string} position left / right / top / bottom。
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} [curvature]
 * @returns {[number, number]}
 */
function bezierControlPoint(position, x1, y1, x2, y2, curvature = 0.25) {
  switch (position) {
    case 'left':
      return [x1 - bezierControlOffset(x1 - x2, curvature), y1]
    case 'right':
      return [x1 + bezierControlOffset(x2 - x1, curvature), y1]
    case 'top':
      return [x1, y1 - bezierControlOffset(y1 - y2, curvature)]
    case 'bottom':
      return [x1, y1 + bezierControlOffset(y2 - y1, curvature)]
    default:
      return [x1, y1]
  }
}

/**
 * 回退用的选择边贝塞尔：端点钉在连接点，只错开控制点。
 *
 * @param {object} params
 * @returns {{path: string, labelX: number, labelY: number}}
 */
export function graphChoiceBezierPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = 'right',
  targetPosition = 'left',
  parallelSourceOffsetY,
  parallelTargetOffsetY,
  parallelOffsetY = 0,
  curvature = 0.25,
}) {
  const sourceLift = parallelSourceOffsetY ?? parallelOffsetY
  const targetLift = parallelTargetOffsetY ?? parallelOffsetY
  const [sourceControlX, sourceControlY0] = bezierControlPoint(
    sourcePosition,
    sourceX,
    sourceY,
    targetX,
    targetY,
    curvature,
  )
  const [targetControlX, targetControlY0] = bezierControlPoint(
    targetPosition,
    targetX,
    targetY,
    sourceX,
    sourceY,
    curvature,
  )
  const sourceControlY = sourceControlY0 + sourceLift
  const targetControlY = targetControlY0 + targetLift
  const labelX = sourceX * 0.125 + sourceControlX * 0.375 + targetControlX * 0.375 + targetX * 0.125
  const labelY = sourceY * 0.125 + sourceControlY * 0.375 + targetControlY * 0.375 + targetY * 0.125
  return {
    path: `M${sourceX},${sourceY} C${sourceControlX},${sourceControlY} ${targetControlX},${targetControlY} ${targetX},${targetY}`,
    labelX,
    labelY,
  }
}

/**
 * 按键把边下标收成组，组内按稳定 id 排序。
 *
 * @param {Array<{id?: string}>} edges
 * @param {(edge: object) => string} keyOf
 * @returns {Map<string, number[]>}
 */
function groupedEdgeIndexes(edges, keyOf) {
  const groups = new Map()
  ;(edges || []).forEach((edge, index) => {
    const key = keyOf(edge)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(index)
  })
  for (const members of groups.values()) {
    members.sort((left, right) => {
      const leftId = edges[left].id || String(left)
      const rightId = edges[right].id || String(right)
      return leftId.localeCompare(rightId)
    })
  }
  return groups
}

/**
 * 为每条可见边标上出边/入边错开量，供回退贝塞尔使用。
 *
 * @param {Array<{id?: string, source?: string, target?: string}>} edges
 * @returns {Array<object>}
 */
export function annotateParallelEdges(edges) {
  const list = edges || []
  const byPair = groupedEdgeIndexes(list, (edge) => graphPairKey(edge.source, edge.target))
  const bySource = groupedEdgeIndexes(list, (edge) => edge.source || '')
  const byTarget = groupedEdgeIndexes(list, (edge) => edge.target || '')
  return list.map((edge, index) => {
    const pairMembers = byPair.get(graphPairKey(edge.source, edge.target)) || [index]
    const sourceMembers = bySource.get(edge.source || '') || [index]
    const targetMembers = byTarget.get(edge.target || '') || [index]
    const parallelIndex = pairMembers.indexOf(index)
    const sourceIndex = sourceMembers.indexOf(index)
    const targetIndex = targetMembers.indexOf(index)
    const parallelSourceOffsetY = parallelEdgeOffsetY(sourceIndex, sourceMembers.length)
    const parallelTargetOffsetY = parallelEdgeOffsetY(targetIndex, targetMembers.length)
    return {
      ...edge,
      parallelIndex,
      parallelCount: pairMembers.length,
      parallelOffsetY: parallelSourceOffsetY,
      parallelSourceOffsetY,
      parallelTargetOffsetY,
    }
  })
}

/** 事件网络节点尺寸与列间距。 */
export const EVENT_GRAPH_LAYOUT = {
  nodeWidth: 190,
  nodeHeight: 60,
  nodesep: 72,
  edgesep: 28,
  ranksep: 240,
  marginx: 32,
  marginy: 44,
}

/** 情节网络节点尺寸与列间距。 */
export const SCENE_GRAPH_LAYOUT = {
  nodeWidth: 190,
  nodeHeight: 66,
  nodesep: 64,
  edgesep: 24,
  ranksep: 220,
  marginx: 24,
  marginy: 40,
}

/**
 * 用 dagre 计算左→右分层坐标。保留给聚焦以外的简单调用；正式画布改用 layoutNarrativeGraph。
 *
 * @param {string[]} nodeIds
 * @param {Array<{source?: string, target?: string}>} edges
 * @param {typeof EVENT_GRAPH_LAYOUT} options
 * @returns {Record<string, {x: number, y: number}>}
 */
export function layoutDirectedGraph(nodeIds, edges, options) {
  return layoutNarrativeGraph(nodeIds, edges, options).nodePositions
}

/**
 * 用 dagre 只提取列号和列内顺序，不采用它的最终坐标。
 *
 * @param {string[]} nodeIds
 * @param {Array<{id?: string, source?: string, target?: string}>} edges
 * @param {typeof EVENT_GRAPH_LAYOUT} options
 * @returns {string[][]} 从左到右的列，每列内按稳定顺序排列的节点 id。
 */
export function assignGraphColumns(nodeIds, edges, options) {
  const {
    nodeWidth,
    nodeHeight,
    nodesep,
    edgesep = 20,
    ranksep,
    marginx = 28,
    marginy = 28,
  } = options
  const g = new dagre.graphlib.Graph({ directed: true, multigraph: true })
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: 'LR',
    nodesep,
    edgesep,
    ranksep,
    marginx,
    marginy,
  })
  nodeIds.forEach((id) => g.setNode(id, { width: nodeWidth, height: nodeHeight }))
  edges.forEach((edge, index) => {
    if (nodeIds.includes(edge.source) && nodeIds.includes(edge.target)) {
      const name = edge.id || `e-${index}-${edge.source}->${edge.target}`
      g.setEdge(edge.source, edge.target, {}, name)
    }
  })
  dagre.layout(g)

  const ranked = nodeIds.map((id) => {
    const node = g.node(id) || { x: 0, y: 0 }
    return { id, x: node.x || 0, y: node.y || 0 }
  })
  const uniqueXs = [...new Set(ranked.map((item) => Math.round(item.x)))].sort((a, b) => a - b)
  const columns = uniqueXs.map(() => [])
  ranked
    .slice()
    .sort((left, right) => left.y - right.y || left.id.localeCompare(right.id))
    .forEach((item) => {
      const col = uniqueXs.indexOf(Math.round(item.x))
      columns[col < 0 ? 0 : col].push(item.id)
    })
  return columns.filter((column) => column.length > 0)
}

/**
 * 事件/情节网络的前向布局入口。
 *
 * @param {string[]} nodeIds 要布局的节点稳定 id。
 * @param {Array<{id?: string, source?: string, target?: string, label?: string, condition?: object}>} edges
 * @param {typeof EVENT_GRAPH_LAYOUT} options 节点尺寸与间距。
 * @returns {{
 *   nodePositions: Record<string, {x:number,y:number}>,
 *   labelBoxes: Record<string, {x:number,y:number,width:number,height:number}>,
 *   edgeRoutes: Record<string, {points: Array<{x:number,y:number}>, path: string, wireY: number}>,
 *   columns: string[][],
 *   channels: Array<object>,
 * }}
 */
export function layoutNarrativeGraph(nodeIds, edges, options) {
  const ids = (nodeIds || []).filter(Boolean)
  const {
    nodeWidth,
    nodeHeight,
    nodesep,
    ranksep,
    marginx = 28,
    marginy = 28,
  } = options
  const columnGap = graphColumnGap(ranksep)
  const validEdges = (edges || [])
    .map((edge, index) => ({
      ...edge,
      layoutKey: edgeLayoutKey(edge, index),
      layoutIndex: index,
    }))
    .filter((edge) => ids.includes(edge.source) && ids.includes(edge.target))

  if (ids.length === 0) {
    return {
      nodePositions: {},
      labelBoxes: {},
      edgeRoutes: {},
      columns: [],
      channels: [],
    }
  }

  const columns = assignGraphColumns(ids, validEdges, options)
  const columnOf = new Map()
  columns.forEach((column, col) => {
    column.forEach((id) => columnOf.set(id, col))
  })

  const nodePositions = {}
  const labelBoxes = {}
  const channels = []
  const corridorLabels = columns.map(() => [])
  let backEdgeCount = 0

  columns.forEach((column, col) => {
    const columnX = marginx + col * (nodeWidth + columnGap)
    const nodeBands = channels
      .filter((channel) => col > channel.fromCol && col < channel.toCol)
      .map((channel) => ({ y: channel.y, height: channel.height }))
    let yCursor = marginy

    column.forEach((id) => {
      yCursor = pushPastBands(yCursor, nodeHeight, nodeBands, GRAPH_BOX_GAP)
      nodePositions[id] = { x: columnX, y: yCursor }
      yCursor += nodeHeight + nodesep
    })

    const outgoing = validEdges
      .filter((edge) => columnOf.get(edge.source) === col)
      .sort((left, right) => compareEdgeIds(left, right))

    outgoing.forEach((edge) => {
      const sourceCol = columnOf.get(edge.source)
      const targetCol = columnOf.get(edge.target)
      const sourcePos = nodePositions[edge.source]
      const handleY = sourcePos.y + nodeHeight / 2
      const isBack = targetCol <= sourceCol
      const corridorPad = (columnGap - GRAPH_EDGE_LABEL_MAX_WIDTH) / 2
      const labelX = columnX + nodeWidth + corridorPad
      const box = {
        x: labelX,
        y: 0,
        width: GRAPH_EDGE_LABEL_MAX_WIDTH,
        height: GRAPH_EDGE_LABEL_MAX_HEIGHT,
      }

      if (isBack) {
        backEdgeCount += 1
        box.y = marginy - backEdgeCount * GRAPH_BACK_EDGE_GAP - GRAPH_EDGE_LABEL_MAX_HEIGHT
      } else {
        const occupied = [
          ...corridorLabels[col],
          ...channels
            .filter((channel) => col >= channel.fromCol && col < channel.toCol)
            .map((channel) => ({
              x: labelX,
              y: channel.y,
              width: GRAPH_EDGE_LABEL_MAX_WIDTH,
              height: channel.height,
            })),
        ]
        box.y = placeLabelY(handleY - GRAPH_EDGE_LABEL_MAX_HEIGHT / 2, box, occupied)
        corridorLabels[col].push({ ...box })
      }

      labelBoxes[edge.layoutKey] = box

      if (!isBack && targetCol > sourceCol + 1) {
        const wireY = box.y + box.height / 2
        channels.push({
          edgeId: edge.layoutKey,
          fromCol: sourceCol,
          toCol: targetCol,
          y: wireY - 6,
          height: 12,
          wireY,
        })
      }
    })
  })

  const handleOf = (id, side) => {
    const pos = nodePositions[id]
    if (!pos) return { x: 0, y: 0 }
    return {
      x: side === 'source' ? pos.x + nodeWidth : pos.x,
      y: pos.y + nodeHeight / 2,
    }
  }

  const edgeRoutes = {}
  validEdges.forEach((edge) => {
    const start = handleOf(edge.source, 'source')
    const end = handleOf(edge.target, 'target')
    const box = labelBoxes[edge.layoutKey]
    const points = buildLabelAlignedRoute(start, end, box)
    const wireY = box ? box.y + box.height / 2 : start.y
    edgeRoutes[edge.layoutKey] = {
      points,
      path: roundedOrthogonalPath(points),
      wireY,
    }
  })

  return {
    nodePositions,
    labelBoxes,
    edgeRoutes,
    columns,
    channels,
  }
}

/**
 * 生成穿过选项框中线的正交折点。
 * 上下转向在框外完成，再以水平线接入/穿出框中线，避免垂直段贴住左右边框。
 *
 * @param {{x:number,y:number}} start 右侧出边连接点。
 * @param {{x:number,y:number}} end 左侧入边连接点。
 * @param {{x:number,y:number,width:number,height:number}|undefined} box 该边的标签框。
 * @returns {Array<{x:number,y:number}>}
 */
export function buildLabelAlignedRoute(start, end, box) {
  const stub = GRAPH_WIRE_LANE
  const targetStubX = end.x - stub
  if (!box) {
    return [
      start,
      { x: start.x + stub, y: start.y },
      { x: start.x + stub, y: end.y },
      end,
    ]
  }
  const midY = box.y + box.height / 2
  const labelLeft = box.x
  const labelRight = box.x + box.width
  const approachX = labelLeft - GRAPH_LABEL_ROUTE_GAP
  const exitX = labelRight + GRAPH_LABEL_ROUTE_GAP
  const through = [
    start,
    { x: approachX, y: start.y },
    { x: approachX, y: midY },
    { x: labelLeft, y: midY },
    { x: labelRight, y: midY },
    { x: exitX, y: midY },
  ]
  if (targetStubX >= exitX) {
    return [
      ...through,
      { x: targetStubX, y: midY },
      { x: targetStubX, y: end.y },
      end,
    ]
  }
  const busY = box.y - GRAPH_BOX_GAP
  return [
    ...through,
    { x: exitX, y: busY },
    { x: targetStubX, y: busY },
    { x: targetStubX, y: end.y },
    end,
  ]
}

/**
 * 在走廊中为标签找一个不与已有框重叠的 y。
 *
 * @param {number} preferredY 希望靠近源节点的上沿。
 * @param {{x:number,width:number,height:number}} box 宽高已定的标签框。
 * @param {Array<{x:number,y:number,width:number,height:number}>} occupied 已占用框。
 * @returns {number}
 */
function placeLabelY(preferredY, box, occupied) {
  const bands = (occupied || []).map((item) => ({
    y: item.y,
    height: item.height,
  }))
  return pushPastBands(preferredY, box.height, bands, GRAPH_LABEL_SLOT_GAP)
}

/**
 * 边的稳定排序：先 id，再起止，再原始下标。
 *
 * @param {{id?: string, source?: string, target?: string, layoutIndex?: number}} left
 * @param {{id?: string, source?: string, target?: string, layoutIndex?: number}} right
 * @returns {number}
 */
function compareEdgeIds(left, right) {
  const leftId = left.id || `${left.source}->${left.target}`
  const rightId = right.id || `${right.source}->${right.target}`
  const byId = leftId.localeCompare(rightId)
  if (byId !== 0) return byId
  return (left.layoutIndex || 0) - (right.layoutIndex || 0)
}
