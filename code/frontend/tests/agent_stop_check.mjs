/**
 * Agent「停止并撤销本轮」前端状态机、确认文案与回滚刷新契约。
 *
 * 运行：node tests/agent_stop_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyTraceEvent,
  isDuplicateTraceEvent,
  isStepExpanded,
} from '../src/hooks/useExecutionTrace.js'
import { createRefreshCoordinator } from '../src/hooks/useProjectRefresh.js'
import {
  createAgentTurnReconciler,
  isActiveChatRunStatus,
  isTerminalChatRunStatus,
} from '../src/hooks/useAgentTurnReconciliation.js'
import {
  classifyChatRun,
  classifyProcessEvent,
  isStartBindPending,
  shouldBindUnknownTurnStart,
} from '../src/turnSettlement.js'

const root = dirname(fileURLToPath(import.meta.url))
const chatSource = readFileSync(join(root, '../src/components/ChatPanel.jsx'), 'utf8')
const agentDict = readFileSync(join(root, '../src/i18n/dictionaries/agent.js'), 'utf8')
const apiSource = readFileSync(join(root, '../src/api.js'), 'utf8')
const eventsSource = readFileSync(join(root, '../src/hooks/useProjectEvents.js'), 'utf8')
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')

assert.match(agentDict, /停止并撤销本轮/, 'running 显示停止并撤销本轮')
assert.match(chatSource, /agent\.chat\.stopAndUndo/, '停止按钮读取稳定 key')
assert.match(
  agentDict,
  /停止后会结束当前生成，并撤销从你发送本轮消息以来的全部修改，不能保留部分结果/,
  '确认文案明确整轮撤销且不能部分保留',
)
assert.match(chatSource, /agent\.chat\.stopConfirm/, '确认框读取稳定 key')
assert.match(agentDict, /正在停止并撤销/, 'stop request 后按钮改为正在停止')
assert.match(chatSource, /agent\.chat\.stopping/, '停止中文案读取稳定 key')
assert.match(chatSource, /disabled=\{stopping \|\| stopBusy\}/, '停止中不可重复点击')
assert.match(chatSource, /chat-stop-compact/, '折叠时仍保留紧凑停止入口')
assert.match(apiSource, /stopChat/, '前端封装停止 API')
assert.match(eventsSource, /turn_stop_requested/, 'SSE 订阅停止请求')
assert.match(eventsSource, /turn_stopped/, 'SSE 订阅停止完成')
assert.match(eventsSource, /'ready'/, 'SSE 订阅 ready 供重连校准')
assert.match(appSource, /turnPhase === 'stop_requested'/, 'SSE 重连可恢复 stop_requested 相位')
assert.match(appSource, /preview_revoked/, '停止/失败撤销预览代次')
assert.match(appSource, /generationPreviewRef\.current\.cancel\(\)/, '停止后取消在途预览 GET')
assert.match(appSource, /useAgentTurnReconciliation/, 'App 接入回合校准器')
assert.match(appSource, /ready: \(\) => \{/, 'SSE ready 触发立即校准')
assert.match(appSource, /reconcileNow\(\)/, 'ready 调用 reconcileNow')
assert.match(appSource, /restoreSettledTurn/, '终态走统一历史恢复')
assert.match(appSource, /turn_stopped: \(p\) => \{[\s\S]*reconcileNow\(\)/, 'turn_stopped 唤醒校准器')
assert.match(appSource, /turn_end: \(p\) => \{[\s\S]*reconcileNow\(\)/, 'turn_end 唤醒校准器')
assert.match(appSource, /onTerminal: restoreSettledTurn/, '校准器看到终态后才恢复页面')
assert.match(appSource, /onOrphaned: recoverOrphanedTurn/, '无法绑定回合时走幽灵运行恢复')
assert.match(appSource, /shouldBindUnknownTurnStart/, '启动窗口内 SSE turn_start 可直接绑定')
assert.match(appSource, /err.status === 409[\s\S]*reconcileNow/, '停止 409 立即校准权威状态')
assert.match(appSource, /TURN_START_BIND_TIMEOUT_MS/, '启动绑定窗口有超时')
assert.match(appSource, /loadCanonicalWorkspace/, '幽灵恢复与终态对账共用权威读取')
assert.doesNotMatch(appSource, /alreadyIdle/, 'idle/busy=false 不能跳过未对账终态')
assert.match(appSource, /createTerminalTurnSettlement/, '终态按 project_id + turn_id 去重对账')
assert.match(appSource, /settlementRetry/, '对账失败后继续询问 /chat/run')
assert.match(appSource, /agentTurnActive/, '事件图画布按 Agent 回合相位保留有效图')
assert.match(appSource, /error: \(p\) => \{[\s\S]*reconcileNow\(\)/, 'error 唤醒校准器')
assert.match(appSource, /classifyTurnEvent/, '带 turn_id 的通知先判断当前/过期/未知')
assert.match(appSource, /classifyProcessEvent/, '过程事件统一按 turn_id 路由')
assert.match(appSource, /const sendMessage = async/, '发送走 async/await，同步异常也进入恢复')
assert.match(appSource, /err\.status >= 400 && err\.status < 500/, '明确 4xx 撤销乐观占位并保留输入')
assert.match(appSource, /result\?\.outcome === 'active'/, '网络失败先校准，活动则不算 orphan')
assert.match(chatSource, /result\?\.accepted/, 'ChatPanel 等发送被接受后才清空输入')
assert.match(apiSource, /chat: \(id, message, locale = 'zh-CN'/, 'api.chat 走 POST /projects/{id}/chat')
{
  const errorHandler = appSource.match(/error: \(p\) => \{[\s\S]*?\n    \},/)
  assert.ok(errorHandler, '能定位 SSE error 处理函数')
  assert.doesNotMatch(
    errorHandler[0],
    /setTurnPhase\('idle'\)/,
    'error 不得先 idle 再让 turn_end 跳过恢复',
  )
}
assert.match(appSource, /api\.getData\(projectId, type\)/, '终态快照严格读取片段，失败会拒绝')
assert.match(appSource, /markSettled\(id, run\.turn_id\)/, '初次打开已加载终态后不再因 ready 全量刷新')

const seen = new Set()
assert.equal(isDuplicateTraceEvent(seen, { turn_id: 't-stop', sequence: 1 }), false)
assert.equal(isDuplicateTraceEvent(seen, { turn_id: 't-stop', sequence: 1 }), true)

let message = {
  role: 'assistant',
  streaming: true,
  steps: [
    { stepId: 'write', tool: 'write_file', label: '正在撰写内容', done: false },
  ],
}
message = applyTraceEvent(message, 'turn_stopped', {
  turn_id: 't-stop',
  sequence: 2,
  text: '已停止，本轮修改均未保留',
  rolled_back: true,
})
assert.equal(message.stopped, true, 'turn_stopped 标记本轮已停止')
assert.equal(message.changeset, null, '停止后没有 changeset')
assert.equal(message.partial, false, '停止不是预算部分收口')
assert.equal(message.steps[0].outcome, 'rolled_back', '已运行步骤标为 rolled_back')
assert.equal(message.steps[0].done, true, '已运行步骤收口为 done')
assert.equal(
  isStepExpanded(message.steps[0], message.steps),
  true,
  '撤销步骤保持展开，不显示成功勾语义',
)

const coordinator = createRefreshCoordinator({ delayMs: 50 })
let ran = 0
coordinator.schedule('world', { data_type: 'world' }, () => {
  ran += 1
})
coordinator.cancel()
assert.equal(ran, 0, 'cancel 丢弃尚未执行的预览刷新')
assert.equal(coordinator.pendingKeys().length, 0, '回滚后预览队列为空')

const completed = applyTraceEvent(
  { role: 'assistant', streaming: true, steps: [] },
  'turn_completed',
  {
    text: '已完成',
    partial: true,
    budget_closed: true,
    remaining_parts: ['情节网络'],
    changeset: { id: 'cs-1', status: 'pending' },
  },
)
assert.equal(completed.partial, true, '正常 turn_completed 部分收口行为不变')
assert.equal(completed.changeset.id, 'cs-1', '正常完成仍携带 changeset')
assert.equal(completed.stopped, undefined, '正常完成不是用户停止')

assert.equal(isActiveChatRunStatus('stop_requested'), true)
assert.equal(isTerminalChatRunStatus('stopped'), true)
assert.equal(isTerminalChatRunStatus('idle'), true)

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = { at: now + ms, fn }
      timers.push(id)
      return id
    },
    clearSchedule(id) {
      const index = timers.indexOf(id)
      if (index >= 0) timers.splice(index, 1)
    },
    async flush(ms = 0) {
      now += ms
      const due = timers.filter((timer) => timer.at <= now)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
        await timer.fn()
      }
    },
    pendingCount() {
      return timers.length
    },
  }
}

const wait = () => new Promise((resolve) => setImmediate(resolve))

{
  const clock = createFakeClock()
  const calls = []
  const active = []
  const terminal = []
  let status = 'stop_requested'
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async (projectId) => {
      calls.push(projectId)
      return { turn_id: 't-1', status }
    },
    onActive: (run) => active.push(run.status),
    onTerminal: (run) => terminal.push(run.status),
  })
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-1', polling: true })
  await wait()
  assert.equal(calls.length, 1, '进入停止中立即校准一次')
  assert.deepEqual(active, ['stop_requested'])
  status = 'stopped'
  await clock.flush(749)
  assert.equal(calls.length, 1, '间隔未到不发下一请求')
  await clock.flush(1)
  await wait()
  assert.equal(calls.length, 2, '750ms 后再问一次')
  assert.deepEqual(terminal, ['stopped'])
  assert.equal(reconciler.snapshot().polling, false, '终态后停止轮询')
  await clock.flush(750)
  assert.equal(calls.length, 2, '终态后不再轮询')
  assert.equal(terminal.length, 1, '终态恢复只触发一次')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const calls = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => {
      calls.push('run')
      return { turn_id: 't-1', status: 'stopped' }
    },
    onActive: () => {},
    onTerminal: () => {},
  })
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-1', polling: false })
  const result = await reconciler.reconcileNow()
  assert.equal(result.outcome, 'terminal', 'ready 立即校准不必等定时器')
  assert.equal(calls.length, 1)
  assert.equal(clock.pendingCount(), 0, '未开启轮询时不挂定时器')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const first = createDeferred()
  const calls = []
  const terminal = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => {
      calls.push('run')
      if (calls.length === 1) return first.promise
      return { turn_id: 't-1', status: 'stopped' }
    },
    onActive: () => {},
    onTerminal: () => terminal.push('stopped'),
  })
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-1', polling: true })
  await wait()
  const busy = await reconciler.reconcileNow()
  assert.equal(busy.outcome, 'busy', '进行中请求时拒绝重叠校准')
  assert.equal(calls.length, 1)
  first.resolve({ turn_id: 't-1', status: 'stopped' })
  await wait()
  assert.equal(terminal.length, 1, '重叠触发不会重复终态恢复')
  const duplicate = await reconciler.reconcileNow()
  assert.equal(duplicate.duplicate, true)
  assert.equal(terminal.length, 1)
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const first = createDeferred()
  const terminal = []
  const active = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async (projectId) => {
      if (projectId === 'old') return first.promise
      return { turn_id: 't-new', status: 'running' }
    },
    onActive: (run) => active.push(run.turn_id),
    onTerminal: (run) => terminal.push(run),
  })
  reconciler.configure({ projectId: 'old', expectedTurnId: 't-old', polling: true })
  await wait()
  reconciler.configure({ projectId: 'new', expectedTurnId: 't-new', polling: true })
  first.resolve({ turn_id: 't-old', status: 'stopped' })
  await wait()
  await wait()
  assert.equal(terminal.length, 0, '切项目后丢弃旧项目迟到终态')
  assert.ok(active.includes('t-new'), '新项目活动态仍可校准')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const first = createDeferred()
  const terminal = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => first.promise,
    onActive: () => {},
    onTerminal: (run) => terminal.push(run.status),
  })
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-1', polling: true })
  await wait()
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-2', polling: false })
  first.resolve({ turn_id: 't-1', status: 'stopped' })
  await wait()
  assert.equal(terminal.length, 0, '开启新回合后丢弃旧回合迟到终态')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const terminal = []
  let fail = true
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => {
      if (fail) throw new Error('network')
      return { turn_id: 't-1', status: 'stopped' }
    },
    onActive: () => {},
    onTerminal: (run) => terminal.push(run.status),
  })
  reconciler.configure({ projectId: 'p1', expectedTurnId: 't-1', polling: true })
  await wait()
  assert.equal(terminal.length, 0, '查询失败不误报完成')
  assert.equal(reconciler.snapshot().polling, true, '失败后继续保持停止中轮询')
  fail = false
  await clock.flush(750)
  await wait()
  assert.deepEqual(terminal, ['stopped'], '失败后下一次校准仍可恢复')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const terminal = []
  const active = []
  let status = 'running'
  const reconciler = createAgentTurnReconciler({
    pollMs: 2500,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => ({ turn_id: 't-1', status }),
    onActive: (run) => active.push(run.status),
    onTerminal: (run) => terminal.push(run.status),
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: 't-1',
    turnPhase: 'running',
    polling: true,
    pollMs: 2500,
  })
  await wait()
  assert.deepEqual(active, ['running'], '生成中也会立即校准一次')
  await clock.flush(2499)
  assert.equal(active.length, 1, '生成中低频校准，间隔未到不再请求')
  status = 'completed'
  await clock.flush(1)
  await wait()
  assert.deepEqual(terminal, ['completed'], '漏收 turn_end 时轮询仍能发现 completed')
  assert.equal(reconciler.snapshot().polling, false, '发现终态后停止轮询')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const terminal = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => ({ turn_id: 't-old', status: 'completed' }),
    onActive: () => {},
    onTerminal: (run) => terminal.push(run.turn_id),
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: null,
    turnPhase: 'running',
    startPending: true,
    polling: true,
  })
  await wait()
  assert.equal(terminal.length, 0, '新回合尚未绑定 turn_id 时，不得把上一轮终态当成当前结果')
  assert.equal(reconciler.snapshot().polling, true, '尚未绑定时继续校准')
  reconciler.dispose()
}

assert.equal(
  classifyChatRun({
    run: { status: 'idle', turn_id: null },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: true,
  }),
  'ignore-pending-bind',
  'POST 返回前第一次匿名 idle 可忽略',
)
assert.equal(
  classifyChatRun({
    run: { status: 'idle', turn_id: null },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: false,
  }),
  'orphaned',
  'POST 已结束仍无 turn_id 时必须恢复',
)
assert.equal(
  classifyChatRun({
    run: { status: 'running', turn_id: 't-new' },
    currentTurnId: null,
    turnPhase: 'running',
    startPending: true,
  }),
  'active',
  '后端已活动时直接采用其 turn_id',
)
assert.equal(
  classifyChatRun({
    run: { status: 'completed', turn_id: 't-old' },
    currentTurnId: 't-new',
    turnPhase: 'running',
  }),
  'stale',
  '已绑定本轮后拒绝其他旧回合终态',
)
assert.equal(
  isStartBindPending({ startPending: true, startTimedOut: false }),
  true,
)
assert.equal(
  isStartBindPending({ startPending: true, startTimedOut: true }),
  false,
)
assert.equal(
  shouldBindUnknownTurnStart({
    eventTurnId: 't-sse',
    currentTurnId: null,
    startPending: true,
  }),
  true,
  'SSE turn_start 在等待启动且尚未绑定时可抢先绑定',
)
assert.equal(
  shouldBindUnknownTurnStart({
    eventTurnId: 't-sse',
    currentTurnId: null,
    startPending: false,
  }),
  false,
)

{
  const clock = createFakeClock()
  const calls = []
  const orphaned = []
  const terminal = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => {
      calls.push('run')
      return { turn_id: null, status: 'idle' }
    },
    onActive: () => {},
    onTerminal: (run) => terminal.push(run.status),
    onOrphaned: (run) => orphaned.push(run.status),
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: null,
    turnPhase: 'running',
    startPending: true,
    polling: true,
  })
  await wait()
  assert.equal(orphaned.length, 0, '启动窗口内匿名 idle 不恢复')
  assert.equal(terminal.length, 0)
  assert.equal(reconciler.snapshot().polling, true)
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: null,
    turnPhase: 'running',
    startPending: false,
    polling: true,
  })
  await wait()
  assert.deepEqual(orphaned, ['idle'], 'POST 结束后无 turn_id 的 idle 进入 orphan 恢复')
  assert.equal(terminal.length, 0, '幽灵运行不得走带 turn_id 的终态对账')
  assert.equal(reconciler.snapshot().polling, false, 'orphan 后停止定时器')
  assert.equal(clock.pendingCount(), 0, 'orphan 后无残留 timer')
  await clock.flush(750)
  assert.equal(calls.length, 2, 'orphan 后不再刷 /chat/run')
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const bound = []
  const orphaned = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => ({ turn_id: 't-live', status: 'running' }),
    onActive: (run) => bound.push(run.turn_id),
    onTerminal: () => {},
    onOrphaned: () => orphaned.push('orphaned'),
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: null,
    turnPhase: 'running',
    startPending: true,
    startTimedOut: true,
    polling: true,
  })
  await wait()
  assert.deepEqual(bound, ['t-live'], '绑定超时后若后端仍活动则采用其 turn_id')
  assert.equal(orphaned.length, 0)
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  const orphaned = []
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => ({ turn_id: null, status: 'idle' }),
    onActive: () => {},
    onTerminal: () => {},
    onOrphaned: () => orphaned.push('idle'),
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: null,
    turnPhase: 'running',
    startPending: true,
    polling: true,
  })
  await wait()
  assert.equal(orphaned.length, 0, '停止 409 前若仍在启动窗口则尚未恢复')
  const result = await reconciler.reconcileNow({ startPending: false, startTimedOut: true })
  assert.equal(result.outcome, 'orphaned', '停止 409 关闭绑定窗口后立即恢复')
  assert.deepEqual(orphaned, ['idle'])
  assert.equal(reconciler.snapshot().polling, false)
  assert.equal(clock.pendingCount(), 0)
  reconciler.dispose()
}

{
  const clock = createFakeClock()
  let settlementAttempts = 0
  const reconciler = createAgentTurnReconciler({
    pollMs: 750,
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule,
    fetchRun: async () => ({ turn_id: 't-retry', status: 'completed' }),
    onActive: () => {},
    onTerminal: async () => {
      settlementAttempts += 1
      return settlementAttempts > 1
    },
  })
  reconciler.configure({
    projectId: 'p1',
    expectedTurnId: 't-retry',
    turnPhase: 'completing',
    polling: true,
  })
  await wait()
  assert.equal(settlementAttempts, 1, '先执行第一次终态页面对账')
  assert.equal(reconciler.snapshot().polling, true, '必要读取未应用时继续轮询')
  assert.equal(reconciler.snapshot().terminalCount, 0, '未应用不得登记终态成功')
  await clock.flush(750)
  await wait()
  assert.equal(settlementAttempts, 2, '下一次轮询重试终态页面对账')
  assert.equal(reconciler.snapshot().polling, false, '页面对账成功后才停止轮询')
  assert.equal(reconciler.snapshot().terminalCount, 1)
  reconciler.dispose()
}

const playtestPanelSource = readFileSync(join(root, '../src/components/PlaytestPanel.jsx'), 'utf8')
assert.doesNotMatch(appSource, /board !== 'playtest' && !isReviewMode/, '试玩页继续渲染同一个 ChatPanel')
assert.match(appSource, /board-surface/, '构建/试玩用显示切换保持挂载')
assert.match(appSource, /tourChatCollapsed === null \? chatCollapsed : tourChatCollapsed/, '构建与试玩共用 Agent 折叠，导览可临时覆盖')
assert.match(appSource, /agentTurnActive=\{agentTurnActive\}/, '试玩接收 Agent 执行锁而不是整页禁用')
assert.doesNotMatch(
  playtestPanelSource,
  /if \(disabled \|\| agentTurnActive\)/,
  'Agent 执行不再触发 PlaytestPanel 整页空状态',
)
assert.match(playtestPanelSource, /pt-session-banner is-paused/, '执行中保留舞台并提示暂停')

assert.equal(
  classifyProcessEvent({ eventTurnId: 't-1', currentTurnId: 't-1' }),
  'current',
)
assert.equal(
  classifyProcessEvent({ eventTurnId: 't-old', currentTurnId: 't-new' }),
  'stale',
)
assert.equal(
  classifyProcessEvent({ eventTurnId: 't-1', currentTurnId: null }),
  'pending-bind',
  '未知身份先校准，不覆盖当前气泡',
)
assert.equal(
  classifyProcessEvent({ eventTurnId: null, currentTurnId: 't-1' }),
  'pending-bind',
)
assert.match(appSource, /bindReturnedTurn\(payload\.turn_id\)/, 'POST 返回的 turn_id 与已绑定 id 冲突时不覆盖')
assert.match(appSource, /workspace\.chrome\.turnIdMismatch/, 'id 冲突记录可见错误并校准')

console.log('agent_stop_check: all assertions passed')
