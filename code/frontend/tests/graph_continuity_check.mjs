/**
 * 图连续呈现：last-good 选择、请求代次、可取消视口调度，以及回合身份状态机。
 *
 * 运行：node tests/graph_continuity_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLatestWinsMap,
  createViewportFitScheduler,
  graphOverlayText,
  hasGraphContent,
  selectDisplayedGraph,
  shouldFitAfterCanvasBecomesVisible,
} from '../src/graphContinuity.js'
import {
  classifyChatRun,
  classifyTurnEvent,
  shouldAcceptPreview,
} from '../src/turnSettlement.js'

const root = dirname(fileURLToPath(import.meta.url))
const eventFormSource = readFileSync(join(root, '../src/components/EventForm.jsx'), 'utf8')
const graphSource = readFileSync(join(root, '../src/components/EventGraphView.jsx'), 'utf8')

assert.equal(hasGraphContent({ nodes: [{ id: 'a' }] }), true)
assert.equal(hasGraphContent({ beats: [{ id: 'b1' }] }), true)
assert.equal(hasGraphContent({ nodes: [] }), false)

const lastGood = { nodes: [{ id: 'keep' }], edges: [] }
assert.deepEqual(
  selectDisplayedGraph(lastGood, { nodes: [] }, { generating: true }).displayed,
  lastGood,
  '生成中的空预览不得清空已有图',
)
assert.equal(
  selectDisplayedGraph(lastGood, { nodes: [] }, { generating: true }).phase,
  'refreshing',
)
assert.deepEqual(
  selectDisplayedGraph(lastGood, null, { failed: true }).displayed,
  lastGood,
  '请求失败仍显示上一份图',
)
assert.equal(
  selectDisplayedGraph(lastGood, null, { failed: true }).phase,
  'stale_error',
)
{
  const next = { nodes: [{ id: 'new' }], edges: [] }
  const selected = selectDisplayedGraph(lastGood, next, { authoritative: true })
  assert.equal(selected.displayed, next)
  assert.equal(selected.phase, 'stable')
}
{
  const empty = selectDisplayedGraph(lastGood, { nodes: [] }, {
    authoritative: true,
    confirmedEmpty: true,
  })
  assert.equal(empty.phase, 'confirmed_empty')
  assert.equal(empty.lastGood, null)
}
assert.equal(
  selectDisplayedGraph(null, { nodes: [] }, { generating: true }).phase,
  'generating_empty',
)
assert.equal(graphOverlayText('refreshing'), '正在刷新，仍显示上一版')
assert.equal(graphOverlayText('stable'), null)
assert.equal(
  shouldFitAfterCanvasBecomesVisible(
    { width: 900, height: 500 },
    { width: 860, height: 500 },
  ),
  false,
  '普通问答提示条或滚动条引起的尺寸变化不得重置视口',
)
assert.equal(
  shouldFitAfterCanvasBecomesVisible(
    { width: 0, height: 0 },
    { width: 900, height: 500 },
  ),
  true,
  '子页返回后画布重新可见时恢复一次视口',
)
assert.equal(
  shouldFitAfterCanvasBecomesVisible(
    { width: 900, height: 500 },
    { width: 0, height: 0 },
  ),
  false,
  '画布隐藏时不适配',
)

{
  const gens = createLatestWinsMap()
  const first = gens.begin('p1:events')
  const second = gens.begin('p1:events')
  assert.equal(gens.isCurrent('p1:events', first), false, '旧代次不能提交')
  assert.equal(gens.isCurrent('p1:events', second), true)
  gens.reset('p1')
  assert.equal(gens.isCurrent('p1:events', second), false, '切项目后作废该项目代次')
}

{
  const timers = new Map()
  let nextId = 0
  const scheduler = createViewportFitScheduler({
    delayMs: 10,
    schedule: (fn) => {
      const id = ++nextId
      timers.set(id, fn)
      return id
    },
    clearSchedule: (id) => timers.delete(id),
    raf: (fn) => {
      fn()
      return 0
    },
    cancelRaf: () => {},
  })
  const fitted = []
  scheduler.requestFit({
    topologyKey: 'a|e1',
    fit: (done) => {
      fitted.push('a')
      done()
    },
  })
  assert.equal(scheduler.snapshot().fittedKey, '', 'fit 完成前不得登记指纹')
  scheduler.requestFit({
    topologyKey: 'a|e1',
    fit: (done) => {
      fitted.push('a-again')
      done()
    },
  })
  scheduler.requestFit({
    topologyKey: 'b|e2',
    fit: (done) => {
      fitted.push('b')
      done()
    },
  })
  for (const fn of [...timers.values()]) fn()
  timers.clear()
  assert.deepEqual(fitted, ['b'], '新拓扑取消尚未执行的旧适配')
  assert.equal(scheduler.snapshot().fittedKey, 'b|e2')

  scheduler.requestFit({
    topologyKey: 'b|e2',
    fit: (done) => {
      fitted.push('b-refit')
      done()
    },
  })
  assert.equal(fitted.includes('b-refit'), false, '同拓扑内容变化不再自动铺满')
}

{
  const timers = []
  let completeFit = null
  const scheduler = createViewportFitScheduler({
    delayMs: 0,
    schedule: (fn) => {
      timers.push(fn)
      return fn
    },
    clearSchedule: (fn) => {
      const index = timers.indexOf(fn)
      if (index >= 0) timers.splice(index, 1)
    },
    raf: (fn) => {
      fn()
      return 0
    },
    cancelRaf: () => {},
  })
  scheduler.requestFit({
    topologyKey: 'query-stable|edges',
    fit: (done) => {
      completeFit = done
    },
  })
  timers.shift()()
  assert.equal(
    scheduler.snapshot().fittedKey,
    '',
    'fitView Promise 尚未完成时不得登记拓扑',
  )
  completeFit()
  assert.equal(
    scheduler.snapshot().fittedKey,
    'query-stable|edges',
    'fitView 实际完成后才登记拓扑',
  )
}

{
  const page = {
    turnId: null,
    phase: 'idle',
    graph: ['old-a', 'old-b'],
    busy: false,
  }
  const applyPreview = (turnId, nodes) => {
    const kind = classifyTurnEvent({ eventTurnId: turnId, currentTurnId: page.turnId })
    if (kind === 'stale') return 'drop'
    if (kind !== 'current') return 'reconcile'
    if (!shouldAcceptPreview(page.phase)) return 'drop'
    page.graph = nodes
    return 'apply'
  }
  const applyTerminal = (turnId) => {
    const kind = classifyTurnEvent({ eventTurnId: turnId, currentTurnId: page.turnId })
    if (kind === 'stale') return 'drop'
    if (kind !== 'current') return 'reconcile'
    page.phase = 'idle'
    page.busy = false
    return 'restore'
  }

  page.phase = 'running'
  page.turnId = null
  page.busy = true
  assert.equal(applyTerminal('t-old'), 'reconcile', 'POST 尚未返回 turn_id 时终态只校准')
  assert.equal(page.phase, 'running', '不得把新回合直接设为 idle')
  assert.deepEqual(page.graph, ['old-a', 'old-b'])

  page.turnId = 't-new'
  assert.equal(applyTerminal('t-old'), 'drop', '上一轮迟到终态不得改新回合')
  assert.equal(page.phase, 'running')
  assert.equal(applyPreview('t-old', []), 'drop')
  assert.deepEqual(page.graph, ['old-a', 'old-b'], '迟到空预览不得清空图')

  page.phase = 'stop_requested'
  assert.equal(applyPreview('t-new', ['preview']), 'drop', '停止中不再装入预览')
  assert.deepEqual(page.graph, ['old-a', 'old-b'])
}

assert.equal(
  classifyChatRun({
    run: { status: 'completed', turn_id: 't-old' },
    currentTurnId: 't-new',
    turnPhase: 'running',
  }),
  'stale',
)

assert.match(eventFormSource, /hidden=\{view !== 'variables'\}/, '状态变量页保持挂载')
assert.match(eventFormSource, /hidden=\{view === 'variables'\}/, '事件网络页保持挂载')
assert.match(
  eventFormSource,
  /const selectGraphNode = useCallback/,
  'Agent 流式文本重渲染时复用事件节点选择回调',
)
assert.match(
  eventFormSource,
  /onSelectNode=\{selectGraphNode\}/,
  '事件画布不接收每次 render 新建的节点回调',
)
assert.match(
  eventFormSource,
  /onSelectEdge=\{selectGraphEdge\}/,
  '事件画布不接收每次 render 新建的边回调',
)
assert.match(graphSource, /markFitted/, '只有实际铺满完成后才登记指纹')
assert.match(
  graphSource,
  /const unreachableKey =/,
  '相同检测结果复用不可达边集合，不重建整图',
)
assert.doesNotMatch(
  graphSource,
  /resized && initialDoneRef/,
  '普通容器尺寸变化不得自动重置事件图视口',
)
assert.match(
  graphSource,
  /Promise\.resolve\(instance\.fitView/,
  '事件图等待 fitView 真正完成',
)

console.log('graph_continuity_check: all assertions passed')
