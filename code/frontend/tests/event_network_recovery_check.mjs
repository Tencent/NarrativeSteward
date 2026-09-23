/**
 * 事件网络终态对账与画布恢复：按 project_id + turn_id 去重，失败可重试，迟到丢弃。
 *
 * 运行：node tests/event_network_recovery_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classifyChatRun,
  classifyProcessEvent,
  classifyTurnEvent,
  createTerminalTurnSettlement,
  shouldAcceptPreview,
  shouldPollChatRun,
  terminalSettlementAction,
  turnSettlementKey,
} from '../src/turnSettlement.js'
import { eventGraphFitAction, eventGraphTopologyKey } from '../src/graphUtils.js'

const root = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')
const graphSource = readFileSync(join(root, '../src/components/EventGraphView.jsx'), 'utf8')
const hookSource = readFileSync(join(root, '../src/hooks/useAgentTurnReconciliation.js'), 'utf8')

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

assert.equal(turnSettlementKey('p1', 't-1'), 'p1:t-1')
assert.equal(turnSettlementKey(null, 't-1'), null)

assert.equal(
  terminalSettlementAction({ projectId: 'p1', turnId: null, status: 'idle' }),
  'skip-anonymous',
  '无 turn_id 的匿名 idle 不触发全量刷新',
)
assert.equal(
  terminalSettlementAction({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    settledKey: 'p1:t-1',
  }),
  'skip-settled',
  '已对账的同一回合忽略后续 ready',
)
assert.equal(
  terminalSettlementAction({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    settlingKey: 'p1:t-1',
  }),
  'join-in-flight',
  '同一回合进行中的恢复共享一次读取',
)
assert.equal(
  terminalSettlementAction({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    settledKey: null,
  }),
  'start',
  '页面已 idle 但该 turn_id 尚未对账时仍要恢复',
)
assert.equal(
  terminalSettlementAction({ projectId: 'p1', turnId: 't-1', status: 'running' }),
  'skip-anonymous',
  '活动回合不同步终态快照',
)

assert.equal(shouldPollChatRun('stop_requested', false), true)
assert.equal(shouldPollChatRun('running', false), true, '生成中也要低频校准 /chat/run')
assert.equal(shouldPollChatRun('completing', false), true, '漏收 turn_end 时 completing 不能停轮询')
assert.equal(shouldPollChatRun('idle', true), true, '终态对账失败后即使 idle 也继续问 /chat/run')
assert.equal(shouldPollChatRun('idle', false), false)

assert.equal(classifyTurnEvent({ eventTurnId: 't-old', currentTurnId: 't-new' }), 'stale')
assert.equal(classifyTurnEvent({ eventTurnId: 't-1', currentTurnId: null }), 'unknown')
assert.equal(classifyTurnEvent({ eventTurnId: 't-1', currentTurnId: 't-1' }), 'current')
assert.equal(
  classifyChatRun({
    run: { status: 'completed', turn_id: 't-old' },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: true,
  }),
  'ignore-pending-bind',
)
assert.equal(
  classifyChatRun({
    run: { status: 'idle', turn_id: null },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: false,
  }),
  'orphaned',
)
assert.equal(
  classifyChatRun({
    run: { status: 'idle', turn_id: null },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: true,
    startTimedOut: true,
  }),
  'orphaned',
)
assert.equal(shouldAcceptPreview('running'), true)
assert.equal(shouldAcceptPreview('stop_requested'), false)

{
  const settlement = createTerminalTurnSettlement()
  const calls = []
  await settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    loadAndApply: async () => {
      calls.push('history')
      calls.push('events')
      return true
    },
  })
  assert.deepEqual(calls, ['history', 'events'], '未对账终态会读取 history 与 events')
  assert.equal(settlement.snapshot().settledKey, 'p1:t-1')

  const again = await settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    loadAndApply: async () => {
      calls.push('again')
      return true
    },
  })
  assert.equal(again.action, 'skip-settled')
  assert.equal(calls.includes('again'), false, '已对账后 ready 不再重复读取')
}

{
  const settlement = createTerminalTurnSettlement()
  const first = createDeferred()
  let applied = 0
  const firstRestore = settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'stopped',
    loadAndApply: async () => {
      await first.promise
      applied += 1
      return true
    },
  })
  const joined = []
  const secondRestore = settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    loadAndApply: async () => {
      applied += 1
      return true
    },
  }).then((result) => {
    joined.push(result.action)
    return result
  })
  const thirdRestore = settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'failed',
    loadAndApply: async () => {
      applied += 1
      return true
    },
  }).then((result) => {
    joined.push(result.action)
    return result
  })
  first.resolve()
  await Promise.all([firstRestore, secondRestore, thirdRestore])
  assert.equal(applied, 1, 'turn_stopped / turn_end / error 连续到达只提交一次快照')
  assert.deepEqual(joined, ['join-in-flight', 'join-in-flight'])
}

{
  const settlement = createTerminalTurnSettlement()
  await assert.rejects(
    () => settlement.restore({
      projectId: 'p1',
      turnId: 't-1',
      status: 'completed',
      loadAndApply: async () => {
        throw new Error('events missing')
      },
    }),
    /events missing/,
  )
  assert.equal(settlement.snapshot().settledKey, null, '必要片段失败不登记已对账')

  const retry = await settlement.restore({
    projectId: 'p1',
    turnId: 't-1',
    status: 'completed',
    loadAndApply: async () => true,
  })
  assert.equal(retry.applied, true, '下一次重试成功后恢复界面')
  assert.equal(settlement.snapshot().settledKey, 'p1:t-1')
}

{
  const settlement = createTerminalTurnSettlement()
  const late = createDeferred()
  const pending = settlement.restore({
    projectId: 'old',
    turnId: 't-old',
    status: 'completed',
    loadAndApply: async () => {
      await late.promise
      return false
    },
  })
  settlement.beginNewTurn()
  const current = await settlement.restore({
    projectId: 'new',
    turnId: 't-new',
    status: 'completed',
    loadAndApply: async () => true,
  })
  late.resolve()
  const stale = await pending
  assert.equal(stale.applied, false, '切项目或开始新回合后丢弃迟到快照')
  assert.equal(current.applied, true)
  assert.equal(settlement.snapshot().settledKey, 'new:t-new')
}

{
  const settlement = createTerminalTurnSettlement()
  settlement.markSettled('p1', 't-ready')
  const result = await settlement.restore({
    projectId: 'p1',
    turnId: 't-ready',
    status: 'completed',
    loadAndApply: async () => {
      throw new Error('should not refetch')
    },
  })
  assert.equal(result.action, 'skip-settled', '初次进入项目已完整加载后，随后 ready 不重复刷新')
}

assert.match(appSource, /api\.getHistory\(projectId\)/, '终态先读 history')
assert.match(appSource, /DATA_TYPES\.map\(async \(type\) => \[type, await api\.getData/, '终态并行读四类片段')
assert.match(hookSource, /shouldPollChatRun\(turnPhase, settlementRetry\)/, '对账失败时继续轮询 /chat/run')
assert.match(graphSource, /agentTurnActive/, '画布按 Agent 回合相位保留有效图')
assert.match(graphSource, /selectDisplayedGraph/, '事件图走共享 last-good 选择')
assert.match(graphSource, /createViewportFitScheduler/, '拓扑铺满走可取消调度器')
assert.match(graphSource, /lastGoodRef\.current = null/, '切项目清空上一项目有效图')
assert.doesNotMatch(graphSource, /topologyKeyRef\.current = nextKey/, '不得在 fitView 前提前登记结构指纹')
assert.match(appSource, /classifyTurnEvent/, 'SSE 先判断回合身份')
assert.match(appSource, /shouldAcceptPreview/, '停止中不再装入新预览')
assert.match(appSource, /setProjectSwitching\(true\)/, '切项目时先保留旧工作区')

const firstGraph = eventGraphTopologyKey([{ id: 'a' }], [{ id: 'e1', source: 'a', target: 'a' }])
let fittedKey = ''
let pendingKey = null
const scheduled = []

function applyFitDecision(topologyKey, firstAppearance = false) {
  const action = eventGraphFitAction({
    topologyKey,
    fittedKey,
    pendingKey,
    firstAppearance,
  })
  if (action === 'keep-pending' || action === 'already-fitted' || action === 'defer-initial' || action === 'skip-empty') {
    return action
  }
  if (pendingKey && pendingKey !== topologyKey) scheduled.push(`cancel:${pendingKey}`)
  pendingKey = topologyKey
  scheduled.push(`fit:${topologyKey}`)
  fittedKey = topologyKey
  pendingKey = null
  return action
}

assert.equal(applyFitDecision(firstGraph, false), 'schedule')
assert.equal(applyFitDecision(firstGraph, false), 'already-fitted')
pendingKey = firstGraph
fittedKey = ''
assert.equal(
  applyFitDecision(firstGraph, false),
  'keep-pending',
  '节点数量改变导致的二次渲染仍保留唯一一次待执行适配',
)
const nextGraph = eventGraphTopologyKey([{ id: 'b' }], [{ id: 'e2', source: 'b', target: 'b' }])
assert.equal(applyFitDecision(nextGraph, false), 'schedule')
assert.ok(scheduled.includes(`cancel:${firstGraph}`), '新拓扑取消旧拓扑任务')

assert.equal(
  classifyProcessEvent({ eventTurnId: 't-old', currentTurnId: 't-new' }),
  'stale',
)
assert.match(appSource, /applyProcessPayload/, '旧回合 tool_*/agent_text 不得写入新气泡')
assert.match(appSource, /pendingPreviewRef\.current = \{\s*epoch/, '未知预览经 /chat/run 确认后才应用')
assert.match(appSource, /pending\.payload\?\.turn_id === run\.turn_id/, '校准确认同一活动回合后才应用暂存预览')

console.log('event_network_recovery_check: all assertions passed')
