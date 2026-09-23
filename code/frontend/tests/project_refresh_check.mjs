/**
 * 面板刷新合并、dirty 预览防护，以及情节按 event id 精准刷新。
 *
 * 运行：node tests/project_refresh_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyPreviewLoadResult,
  combinedPreviewStatus,
  createGenerationPreviewController,
  createPreviewRetryController,
  createRefreshCoordinator,
  eventStagePreviewKeys,
  previewBannerMessage,
  previewBundleRetryKey,
  PREVIEW_RETRY_LIMIT,
  PREVIEW_STATUS,
  refreshKey,
  shouldSkipDirtyPreview,
} from '../src/hooks/useProjectRefresh.js'
import { hasBlockingDraft } from '../src/hooks/useExecutionTrace.js'
import { eventGraphTopologyKey, shouldRefitEventGraph, eventGraphFitAction } from '../src/graphUtils.js'
import {
  EVENT_GRAPH_LAYOUT,
  GRAPH_EDGE_LABEL_MAX_WIDTH,
  GRAPH_LABEL_ROUTE_GAP,
  SCENE_GRAPH_LAYOUT,
  buildLabelAlignedRoute,
  edgeLayoutKey,
  graphColumnGap,
  layoutNarrativeGraph,
  rectsOverlap,
} from '../src/graphLayout.js'
import { classifyChatRun, shouldBindUnknownTurnStart } from '../src/turnSettlement.js'

const root = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(join(root, '../src/components/ScenePanel.jsx'), 'utf8')
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')
const eventGraphSource = readFileSync(join(root, '../src/components/EventGraphView.jsx'), 'utf8')
const sceneGraphSource = readFileSync(join(root, '../src/components/SceneGraphView.jsx'), 'utf8')
const choiceEdgeSource = readFileSync(join(root, '../src/components/GraphChoiceEdge.jsx'), 'utf8')
const layoutSource = readFileSync(join(root, '../src/graphLayout.js'), 'utf8')

assert.equal(refreshKey('world'), 'world')
assert.equal(refreshKey('scenes', 'ev-1'), 'scene:ev-1')
assert.equal(refreshKey('scenes'), 'scenes')

assert.equal(shouldSkipDirtyPreview({ intent: true }, 'intent'), true)
assert.equal(shouldSkipDirtyPreview({ intent: true }, 'world'), false)

assert.equal(previewBannerMessage(PREVIEW_STATUS.loading).includes('尚未正式提交'), false)
assert.equal(previewBannerMessage(PREVIEW_STATUS.retrying).includes('尚未正式提交'), false)
assert.match(previewBannerMessage(PREVIEW_STATUS.ready), /尚未正式提交/)
assert.match(previewBannerMessage(PREVIEW_STATUS.failed), /回合结束时重新读取/)
assert.equal(previewBannerMessage(null), null)

const firstFail = applyPreviewLoadResult('failed', 0)
assert.equal(firstFail.status, PREVIEW_STATUS.retrying)
assert.equal(firstFail.retry, true)
assert.equal(firstFail.keep, false)

const staleLoad = applyPreviewLoadResult('stale', firstFail.failureCount)
assert.equal(staleLoad.keep, true)
assert.equal(staleLoad.retry, false, '被更晚请求取代时不再为这一次失败排队')

const appliedSameRevision = applyPreviewLoadResult('applied', firstFail.failureCount)
assert.equal(appliedSameRevision.status, PREVIEW_STATUS.ready)
assert.equal(appliedSameRevision.failureCount, 0)

let exhausted = applyPreviewLoadResult('failed', 0)
for (let i = 0; i < PREVIEW_RETRY_LIMIT; i += 1) {
  exhausted = applyPreviewLoadResult('failed', exhausted.failureCount)
}
assert.equal(exhausted.status, PREVIEW_STATUS.failed)
assert.equal(exhausted.retry, false, '重试耗尽后等待回合收口')

assert.equal(
  combinedPreviewStatus({ intent: PREVIEW_STATUS.loading }, ['intent']),
  PREVIEW_STATUS.loading,
)
assert.equal(
  combinedPreviewStatus(
    { events: PREVIEW_STATUS.ready, 'scene:ev-1': PREVIEW_STATUS.loading },
    eventStagePreviewKeys({ events: PREVIEW_STATUS.ready, 'scene:ev-1': PREVIEW_STATUS.loading }),
  ),
  PREVIEW_STATUS.loading,
  '事件阶段有任一片段仍在加载时不得宣称预览已就绪',
)
assert.deepEqual(
  eventStagePreviewKeys({ intent: PREVIEW_STATUS.ready, events: PREVIEW_STATUS.ready, 'scene:a': PREVIEW_STATUS.failed }),
  ['events', 'scene:a'],
)

const retryCalls = []
const retryCtl = createPreviewRetryController({ delayMs: 20 })
retryCtl.schedule('intent', () => retryCalls.push('first'))
retryCtl.cancel('intent')
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(retryCalls.length, 0, '终态清理后不得执行旧重试')

retryCtl.schedule('intent', () => retryCalls.push('old'))
retryCtl.schedule('intent', () => retryCalls.push('new'))
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(retryCalls, ['new'], '同键后一次调度取代前一次')

retryCtl.begin('intent')
retryCtl.schedule('intent', () => retryCalls.push('after-begin'))
await new Promise((resolve) => setTimeout(resolve, 50))
assert.deepEqual(retryCalls, ['new', 'after-begin'])

retryCtl.schedule('outline', () => retryCalls.push('outline'))
retryCtl.cancel()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(retryCalls.includes('outline'), false, '全量 cancel 丢掉全部待执行重试')
assert.equal(retryCtl.pendingKeys().length, 0)

const fired = []
const coordinator = createRefreshCoordinator({ delayMs: 20 })
coordinator.schedule('events', { data_type: 'events', n: 1 }, (payload) => fired.push(payload))
coordinator.schedule('events', { data_type: 'events', n: 2 }, (payload) => fired.push(payload))
coordinator.schedule('scene:ev-1', { data_type: 'scenes', event_id: 'ev-1' }, (payload) => fired.push(payload))
assert.deepEqual(coordinator.pendingKeys().sort(), ['events', 'scene:ev-1'])

await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(fired.length, 2, '200ms 内同目标刷新合并')
assert.equal(fired[0].n, 2, '合并后使用最后一次载荷')
assert.equal(fired[1].event_id, 'ev-1', '情节按 event id 独立刷新')

assert.equal(hasBlockingDraft({ events: true }), true, '未保存草稿阻止 Agent 启动')

const firstGraph = eventGraphTopologyKey(
  [{ id: 'a' }, { id: 'b' }],
  [{ id: 'e1', source: 'a', target: 'b' }],
)
const sameGraphNewTitles = eventGraphTopologyKey(
  [{ id: 'a', title: '新标题' }, { id: 'b' }],
  [{ id: 'e1', source: 'a', target: 'b' }],
)
const rewrittenGraph = eventGraphTopologyKey(
  [{ id: 'c' }],
  [{ id: 'e2', source: 'c', target: 'c' }],
)
assert.equal(shouldRefitEventGraph('', firstGraph), true, '首张事件图需要铺满画布')
assert.equal(shouldRefitEventGraph(firstGraph, sameGraphNewTitles), false, '仅标题变化保留视口')
assert.equal(shouldRefitEventGraph(firstGraph, rewrittenGraph), true, '节点 id 重写后重新铺满')
assert.equal(shouldRefitEventGraph(firstGraph, '|'), false, '空图不强制铺满')

assert.equal(
  eventGraphFitAction({ topologyKey: firstGraph, fittedKey: '', pendingKey: firstGraph }),
  'keep-pending',
  '节点数量二次渲染不得取消同一拓扑的待执行铺满',
)
assert.equal(
  eventGraphFitAction({ topologyKey: rewrittenGraph, fittedKey: '', pendingKey: firstGraph }),
  'schedule',
  '新拓扑到达时安排新的铺满，由调用方取消旧任务',
)
assert.equal(
  eventGraphFitAction({ topologyKey: sameGraphNewTitles, fittedKey: firstGraph, pendingKey: null }),
  'already-fitted',
  '仅标题变化不自动改视口',
)
assert.equal(eventGraphFitAction({ topologyKey: '|' }), 'skip-empty', '空图不安排铺满')
assert.equal(
  eventGraphFitAction({ topologyKey: firstGraph, fittedKey: '', pendingKey: null, firstAppearance: true }),
  'defer-initial',
  '首次出图交给初始视口',
)

assert.doesNotMatch(panelSource, /加载情节中/, '情节刷新不得卸载为加载占位')
assert.match(appSource, /setProjectSwitching\(true\)/, '切项目先保留当前工作区')
assert.match(appSource, /return 'applied'/, '片段读取必须回报是否已写入当前面板')
assert.match(appSource, /applyPreviewLoadResult/, '预览条状态由读取结果决定')
assert.match(appSource, /PREVIEW_STATUS\.loading/, '收到预览通知后先进入加载中')
assert.match(appSource, /previewBannerMessage/, '预览条文案与状态绑定')
assert.doesNotMatch(appSource, /\[key\]: true/, '不得再用布尔值把未读到的正文标成已就绪')
const tabChangeSource = appSource.slice(
  appSource.indexOf('const handleTabChange'),
  appSource.indexOf('const handleBoardChange'),
)
assert.doesNotMatch(tabChangeSource, /loadFragment/, '切换标签不承担片段刷新')
assert.match(
  appSource,
  /clearPreviewState\(\)/,
  '新回合、切项目和终态对账必须清掉预览重试',
)

assert.match(eventGraphSource, /layoutNarrativeGraph/, '事件图使用前向布局')
assert.match(sceneGraphSource, /layoutNarrativeGraph/, '情节图使用前向布局')
assert.match(choiceEdgeSource, /applyRouteHandles/, '连线端点钉在实测连接点')
assert.match(choiceEdgeSource, /labelBox/, '标签使用预计算文本框')
assert.match(choiceEdgeSource, /box\.height/, '可见选项卡片撑满预留高度')
assert.doesNotMatch(choiceEdgeSource, /sourceY: sourceY \+ offsetY/, '不得把出边起点从连接点挪开')
assert.doesNotMatch(choiceEdgeSource, /targetY: targetY \+ offsetY/, '不得把入边终点从连接点挪开')
assert.match(layoutSource, /multigraph:\s*true/, '定列仍按多重图登记平行边')
assert.match(layoutSource, /g\.setEdge\(edge\.source, edge\.target, \{\}, name\)/, '平行边使用唯一边名')

function nodeBox(id, placed, options) {
  const pos = placed.nodePositions[id]
  return {
    x: pos.x,
    y: pos.y,
    width: options.nodeWidth,
    height: options.nodeHeight,
  }
}

function assertBoxesDisjoint(boxes, message) {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.equal(rectsOverlap(boxes[i], boxes[j]), false, `${message} (${i},${j})`)
    }
  }
}

function assertRouteThroughLabel(placed, edges) {
  edges.forEach((edge, index) => {
    const box = placed.labelBoxes[edgeLayoutKey(edge, index)]
    const route = placed.edgeRoutes[edgeLayoutKey(edge, index)]
    const midY = box.y + box.height / 2
    const through = (route.points || []).some((point, i) => {
      const next = route.points[i + 1]
      if (!next) return false
      const sameY = Math.abs(point.y - midY) < 0.5 && Math.abs(next.y - midY) < 0.5
      const crosses = Math.min(point.x, next.x) <= box.x + 0.5
        && Math.max(point.x, next.x) >= box.x + box.width - 0.5
      return sameY && crosses
    })
    assert.equal(through, true, `${edge.id} 必须穿过自己的选项框`)
  })
}

function assertTurnsOutsideLabel(placed, edges) {
  edges.forEach((edge, index) => {
    const box = placed.labelBoxes[edgeLayoutKey(edge, index)]
    const route = placed.edgeRoutes[edgeLayoutKey(edge, index)]
    const left = box.x
    const right = box.x + box.width
    const points = route.points || []
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      if (Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) < 0.5) continue
      const x = a.x
      assert.ok(Math.abs(x - left) > 0.5, `${edge.id} 垂直段不得贴左框`)
      assert.ok(Math.abs(x - right) > 0.5, `${edge.id} 垂直段不得贴右框`)
      assert.equal(
        x > left + 0.5 && x < right - 0.5,
        false,
        `${edge.id} 垂直段不得穿进选项框`,
      )
      const nearer = Math.min(Math.abs(x - left), Math.abs(x - right))
      if (nearer <= GRAPH_LABEL_ROUTE_GAP + 18) {
        assert.ok(
          nearer + 0.5 >= GRAPH_LABEL_ROUTE_GAP,
          `${edge.id} 框旁转向须离开边框 ${GRAPH_LABEL_ROUTE_GAP}px`,
        )
      }
    }
  })
}

function assertLabelsCenteredInCorridor(placed, edges, options) {
  const columnGap = graphColumnGap(options.ranksep)
  const expectedPad = (columnGap - GRAPH_EDGE_LABEL_MAX_WIDTH) / 2
  edges.forEach((edge, index) => {
    const source = placed.nodePositions[edge.source]
    const box = placed.labelBoxes[edgeLayoutKey(edge, index)]
    assert.equal(
      box.x,
      source.x + options.nodeWidth + expectedPad,
      `${edge.id} 选项框应水平居中于两列走廊`,
    )
  })
}

function assertHandleEndpoints(placed, edges, options) {
  edges.forEach((edge, index) => {
    const route = placed.edgeRoutes[edgeLayoutKey(edge, index)]
    const source = placed.nodePositions[edge.source]
    const target = placed.nodePositions[edge.target]
    const first = route.points[0]
    const last = route.points[route.points.length - 1]
    assert.equal(first.x, source.x + options.nodeWidth, `${edge.id} 出边起点 x`)
    assert.equal(first.y, source.y + options.nodeHeight / 2, `${edge.id} 出边起点 y`)
    assert.equal(last.x, target.x, `${edge.id} 入边终点 x`)
    assert.equal(last.y, target.y + options.nodeHeight / 2, `${edge.id} 入边终点 y`)
  })
}

const offsetBox = { x: 100, y: 80, width: GRAPH_EDGE_LABEL_MAX_WIDTH, height: 36 }
const offsetRoute = buildLabelAlignedRoute({ x: 40, y: 40 }, { x: 360, y: 200 }, offsetBox)
const offsetMidY = offsetBox.y + offsetBox.height / 2
assert.equal(
  offsetRoute.some((point, i) => {
    const next = offsetRoute[i + 1]
    return next
      && point.y === offsetMidY
      && next.y === offsetMidY
      && Math.min(point.x, next.x) <= offsetBox.x + 0.5
      && Math.max(point.x, next.x) >= offsetBox.x + offsetBox.width - 0.5
  }),
  true,
  '错开后的边仍水平穿过选项框中线',
)
const offsetVerticalXs = []
for (let i = 0; i < offsetRoute.length - 1; i += 1) {
  const a = offsetRoute[i]
  const b = offsetRoute[i + 1]
  if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5) offsetVerticalXs.push(a.x)
}
assert.equal(offsetVerticalXs.includes(offsetBox.x), false, '入口垂直段不得在左框')
assert.equal(offsetVerticalXs.includes(offsetBox.x + offsetBox.width), false, '出口垂直段不得在右框')
assert.ok(offsetVerticalXs.includes(offsetBox.x - GRAPH_LABEL_ROUTE_GAP), '入口应在框外转向')

const backRoute = buildLabelAlignedRoute({ x: 200, y: 40 }, { x: 40, y: 120 }, offsetBox)
const backExitX = offsetBox.x + offsetBox.width + GRAPH_LABEL_ROUTE_GAP
assert.ok(
  backRoute.some((point, i) => {
    const next = backRoute[i + 1]
    return next && Math.abs(point.x - backExitX) < 0.5 && Math.abs(next.x - backExitX) < 0.5
  }),
  '反向边从框外出口再进入上方通道',
)

const fourParallels = [
  { id: 'e-023', source: 'a', target: 'b', label: '四' },
  { id: 'e-020', source: 'a', target: 'b', label: '一' },
  { id: 'e-022', source: 'a', target: 'b', label: '三' },
  { id: 'e-021', source: 'a', target: 'b', label: '二' },
]
const parallelLayout = layoutNarrativeGraph(['a', 'b'], fourParallels, EVENT_GRAPH_LAYOUT)
const parallelBoxes = fourParallels.map((edge) => parallelLayout.labelBoxes[edge.id])
assert.equal(new Set(parallelBoxes.map((box) => `${box.x},${box.y}`)).size, 4, '四条同对边各有独立标签框')
assertBoxesDisjoint(parallelBoxes, '同对平行边标签不得重叠')
assertHandleEndpoints(parallelLayout, fourParallels, EVENT_GRAPH_LAYOUT)
assertLabelsCenteredInCorridor(parallelLayout, fourParallels, EVENT_GRAPH_LAYOUT)
assertRouteThroughLabel(parallelLayout, fourParallels)
assertTurnsOutsideLabel(parallelLayout, fourParallels)
assert.deepEqual(
  parallelLayout.nodePositions,
  layoutNarrativeGraph(['a', 'b'], fourParallels, EVENT_GRAPH_LAYOUT).nodePositions,
  '同一输入重复布局结果一致',
)

const tideNodes = ['tide', 'rescue', 'pursuit']
const tideEdges = [
  { id: 'e-016', source: 'tide', target: 'rescue' },
  { id: 'e-017', source: 'tide', target: 'pursuit' },
  { id: 'e-030', source: 'tide', target: 'rescue' },
  { id: 'e-031', source: 'tide', target: 'pursuit' },
]
const tideLayout = layoutNarrativeGraph(tideNodes, tideEdges, EVENT_GRAPH_LAYOUT)
const tideBoxes = tideEdges.map((edge) => tideLayout.labelBoxes[edge.id])
assert.equal(new Set(tideBoxes.map((box) => box.y)).size, 4, '魔潮式四条出边不得复用走廊')
assertBoxesDisjoint(tideBoxes, '去向不同目标的出边标签也不得重叠')
assertHandleEndpoints(tideLayout, tideEdges, EVENT_GRAPH_LAYOUT)
assertLabelsCenteredInCorridor(tideLayout, tideEdges, EVENT_GRAPH_LAYOUT)
assertRouteThroughLabel(tideLayout, tideEdges)
assertTurnsOutsideLabel(tideLayout, tideEdges)

const remnantNodes = [
  'ev-11-tower-approach',
  'ev-12-remnant-layer',
  'ev-12a-remnant-memory-trial',
  'ev-12b-system-permission-rift',
  'ev-12c-rune-resonance',
  'ev-13-core-hall',
]
const remnantEdges = [
  { id: 'e-020', source: 'ev-11-tower-approach', target: 'ev-12-remnant-layer' },
  { id: 'e-021', source: 'ev-11-tower-approach', target: 'ev-12-remnant-layer' },
  { id: 'e-022', source: 'ev-11-tower-approach', target: 'ev-12-remnant-layer' },
  { id: 'e-023', source: 'ev-11-tower-approach', target: 'ev-12-remnant-layer' },
  { id: 'e-024', source: 'ev-12-remnant-layer', target: 'ev-12b-system-permission-rift' },
  { id: 'e-025', source: 'ev-12-remnant-layer', target: 'ev-12a-remnant-memory-trial' },
  { id: 'e-026', source: 'ev-12-remnant-layer', target: 'ev-13-core-hall' },
  { id: 'e-032', source: 'ev-12-remnant-layer', target: 'ev-12c-rune-resonance' },
  { id: 'e-033', source: 'ev-12-remnant-layer', target: 'ev-12c-rune-resonance' },
  { id: 'e-037', source: 'ev-12a-remnant-memory-trial', target: 'ev-13-core-hall' },
  { id: 'e-038', source: 'ev-12b-system-permission-rift', target: 'ev-13-core-hall' },
  { id: 'e-039', source: 'ev-12c-rune-resonance', target: 'ev-13-core-hall' },
]
const remnantLayout = layoutNarrativeGraph(remnantNodes, remnantEdges, EVENT_GRAPH_LAYOUT)
assert.ok(remnantLayout.columns.length >= 3, '残魂层到核心大厅应跨过中间列')
const skipBox = remnantLayout.labelBoxes['e-026']
assert.ok(skipBox, '跳列边必须有标签框')
for (const id of ['ev-12a-remnant-memory-trial', 'ev-12b-system-permission-rift', 'ev-12c-rune-resonance']) {
  assert.equal(
    rectsOverlap(skipBox, nodeBox(id, remnantLayout, EVENT_GRAPH_LAYOUT)),
    false,
    `跳列边标签不得压住 ${id}`,
  )
}
const remnantNodeBoxes = remnantNodes.map((id) => nodeBox(id, remnantLayout, EVENT_GRAPH_LAYOUT))
const remnantLabelBoxes = remnantEdges.map((edge) => remnantLayout.labelBoxes[edge.id])
assertBoxesDisjoint(remnantNodeBoxes, '事件框不得重叠')
assertBoxesDisjoint(remnantLabelBoxes, '选项框不得重叠')
for (const node of remnantNodeBoxes) {
  for (const label of remnantLabelBoxes) {
    assert.equal(rectsOverlap(node, label), false, '事件框与选项框不得重叠')
  }
}
assertHandleEndpoints(remnantLayout, remnantEdges, EVENT_GRAPH_LAYOUT)
assertLabelsCenteredInCorridor(remnantLayout, remnantEdges, EVENT_GRAPH_LAYOUT)
assertRouteThroughLabel(remnantLayout, remnantEdges)
assertTurnsOutsideLabel(remnantLayout, remnantEdges)

const sceneNodes = ['beat-a', 'beat-b', 'beat-c', 'beat-d']
const sceneEdges = [
  { id: 'se-1', source: 'beat-a', target: 'beat-b', label: '选择甲' },
  { id: 'se-2', source: 'beat-a', target: 'beat-b', label: '选择乙' },
  { id: 'se-3', source: 'beat-b', target: 'beat-c', label: '前进' },
  { id: 'se-4', source: 'beat-c', target: 'beat-d', label: '继续' },
  { id: 'se-skip', source: 'beat-a', target: 'beat-d', label: '跳过' },
  { id: 'se-back', source: 'beat-d', target: 'beat-a', label: '回看' },
]
const sceneLayout = layoutNarrativeGraph(sceneNodes, sceneEdges, SCENE_GRAPH_LAYOUT)
assert.equal(new Set(['se-1', 'se-2'].map((id) => `${sceneLayout.labelBoxes[id].x},${sceneLayout.labelBoxes[id].y}`)).size, 2)
assert.equal(
  rectsOverlap(sceneLayout.labelBoxes['se-skip'], nodeBox('beat-b', sceneLayout, SCENE_GRAPH_LAYOUT)),
  false,
  '情节跳列边标签不得压住中间节拍',
)
assert.equal(
  rectsOverlap(sceneLayout.labelBoxes['se-skip'], nodeBox('beat-c', sceneLayout, SCENE_GRAPH_LAYOUT)),
  false,
  '情节跳列边标签不得压住第二中间节拍',
)
assert.ok(sceneLayout.labelBoxes['se-back'].y < sceneLayout.nodePositions['beat-a'].y, '回边标签走图上方通道')
assertHandleEndpoints(sceneLayout, sceneEdges, SCENE_GRAPH_LAYOUT)
assertLabelsCenteredInCorridor(sceneLayout, sceneEdges, SCENE_GRAPH_LAYOUT)
assertRouteThroughLabel(sceneLayout, sceneEdges)
assertTurnsOutsideLabel(sceneLayout, sceneEdges)
assertBoxesDisjoint(sceneEdges.map((edge) => sceneLayout.labelBoxes[edge.id]), '情节选项框不得重叠')

assert.match(appSource, /data_preview_published/, '预览改走检查点代次事件')
assert.match(appSource, /getTurnPreview/, '预览必须显式 GET bundle')
assert.match(appSource, /preview_revoked/, '撤销代次有独立事件')
assert.match(appSource, /startsWith\('scene:'\)/, 'scene:<id> 不得误走普通 data API')
assert.match(appSource, /checkpoint_invalid/, '非法检查点保留 last-good')
assert.match(appSource, /shouldDisplayStatusNote/, 'status 处理器过滤 Agent 专用提示')
assert.match(appSource, /loadCanonicalWorkspace/, '权威历史与内容恢复抽成共用读取')
assert.match(appSource, /recoverOrphanedTurn/, '幽灵运行走权威恢复')
assert.match(
  appSource,
  /recoverOrphanedTurn = useCallback\([\s\S]*loadCanonicalWorkspace/,
  'orphan 恢复重载正式历史与内容',
)
assert.match(
  appSource,
  /recoverOrphanedTurn = useCallback\([\s\S]*clearPreviewState\(\)/,
  'orphan 恢复取消预览请求',
)
assert.equal(
  classifyChatRun({
    run: { status: 'completed', turn_id: 't-old' },
    currentTurnId: 't-new',
    turnPhase: 'running',
  }),
  'stale',
  '旧回合迟到结果不能覆盖新启动回合',
)
assert.equal(
  shouldBindUnknownTurnStart({
    eventTurnId: 't-new',
    currentTurnId: 't-old',
    startPending: true,
  }),
  false,
  '已有本轮 id 时不把未知 turn_start 当成新绑定',
)
assert.match(panelSource, /previewBundle/, '情节按代次 bundle 原子应用')
assert.doesNotMatch(appSource, /PREVIEW_STATUS\.ready \}\)/, '不得在 GET 成功前直接标 ready')

const generationCtl = createGenerationPreviewController()
const token1 = generationCtl.begin('p1', 't1', 1)
assert.equal(generationCtl.isCurrent('p1', 't1', 1, token1), true, '当前代次可应用')
const token2 = generationCtl.begin('p1', 't1', 2)
assert.equal(generationCtl.isCurrent('p1', 't1', 1, token1), false, '旧代次 GET 晚到不得覆盖')
assert.equal(generationCtl.isCurrent('p1', 't1', 2, token2), true)
generationCtl.revoke('t1', 2)
assert.equal(generationCtl.isRevoked('t1', 2), true, '已撤销代次不得再应用')
generationCtl.cancel()
assert.equal(generationCtl.isCurrent('p1', 't1', 2, token2), false, '终态取消在途请求')

assert.equal(previewBundleRetryKey('p1', 't1', 3), 'p1:t1:3')
assert.match(appSource, /previewRetryRef\.current\.schedule/, 'bundle GET 失败后调度同一代重试')
assert.match(appSource, /isRetry: true/, '重试不得创建新的 preview_generation')
assert.match(appSource, /pendingPreviewRef/, '未知 turn_id 的预览先暂存再校准')

{
  let now = 0
  const timers = []
  const retryCtl = createPreviewRetryController({
    delayMs: 400,
    schedule: (fn, ms) => {
      const handle = { at: now + ms, fn, cancelled: false }
      timers.push(handle)
      return handle
    },
    clearSchedule: (handle) => {
      if (handle) handle.cancelled = true
    },
  })
  const key = previewBundleRetryKey('p1', 't1', 1)
  let attempts = 0
  const payload = { turn_id: 't1', preview_generation: 1 }
  const run = () => {
    attempts += 1
    const outcome = applyPreviewLoadResult('failed', attempts - 1)
    if (outcome.retry) retryCtl.schedule(key, () => run())
  }
  retryCtl.begin(key)
  run()
  assert.equal(attempts, 1)
  now = 400
  for (const timer of [...timers]) {
    if (!timer.cancelled && timer.at <= now) {
      timer.cancelled = true
      timer.fn()
    }
  }
  assert.equal(attempts, 2, '第一次失败后按 400ms 重试同一代')
  now = 800
  for (const timer of [...timers]) {
    if (!timer.cancelled && timer.at <= now) {
      timer.cancelled = true
      timer.fn()
    }
  }
  assert.equal(attempts, 3, '第二次失败后再试一次')
  now = 1200
  for (const timer of [...timers]) {
    if (!timer.cancelled && timer.at <= now) {
      timer.cancelled = true
      timer.fn()
    }
  }
  assert.equal(attempts, 3, '第三次失败后耗尽，不再排队')

  const nextKey = previewBundleRetryKey('p1', 't1', 2)
  retryCtl.begin(nextKey)
  retryCtl.schedule(key, () => {
    attempts += 1
  })
  retryCtl.cancel()
  now = 2000
  for (const timer of [...timers]) {
    if (!timer.cancelled && timer.at <= now) {
      timer.cancelled = true
      timer.fn()
    }
  }
  assert.equal(attempts, 3, '换代或终态取消后旧 timer 不得再跑')
}

assert.match(layoutSource, /approachX/, '入口拐点须离开选项框左边框')

console.log('project_refresh_check: pass')
