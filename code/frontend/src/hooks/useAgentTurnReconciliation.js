/**
 * Agent 回合运行状态校准：SSE 是快速通知，GET /chat/run 是相位事实来源。
 *
 * 停止中按固定间隔询问一次运行状态；SSE ready / 重连可立即校准。
 * 活动态只同步相位，终态交给调用方重拉历史。迟到请求用代次令牌丢弃。
 */

import { useEffect, useRef } from 'react'

import { chatRunPollMs, classifyChatRun, shouldPollChatRun } from '../turnSettlement.js'

/** 后台仍在推进的运行状态，前端应保持只读。 */
export const ACTIVE_CHAT_RUN_STATUSES = ['running', 'stop_requested', 'completing']

/** 后台已收口的运行状态，前端应恢复历史并退出「正在停止」。 */
export const TERMINAL_CHAT_RUN_STATUSES = ['stopped', 'completed', 'failed', 'idle']

export const DEFAULT_RECONCILE_POLL_MS = 750
export { ACTIVE_CHAT_RUN_POLL_MS, TERMINAL_CHAT_RUN_POLL_MS } from '../turnSettlement.js'

/**
 * 判断 /chat/run 状态是否表示回合仍在进行。
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isActiveChatRunStatus(status) {
  return ACTIVE_CHAT_RUN_STATUSES.includes(status)
}

/**
 * 判断 /chat/run 状态是否表示回合已经结束。
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isTerminalChatRunStatus(status) {
  return TERMINAL_CHAT_RUN_STATUSES.includes(status) || !status
}

/**
 * 创建可在 React 外测试的回合校准器。
 *
 * @param {object} options
 * @param {(projectId: string) => Promise<object>} options.fetchRun 读取 /chat/run。
 * @param {(run: object) => void} [options.onActive] 活动态回调。
 * @param {(run: object) => void|Promise<void>} [options.onTerminal] 终态回调。
 * @param {(run: object) => void|Promise<void>} [options.onOrphaned] 启动后无法绑定回合时的恢复回调。
 * @param {number} [options.pollMs] 默认轮询间隔。
 * @param {(fn: Function, ms: number) => *} [options.schedule] 可注入的定时器。
 * @param {(id: *) => void} [options.clearSchedule] 可注入的定时器清理。
 * @returns {{configure: Function, reconcileNow: Function, dispose: Function, snapshot: Function}}
 */
export function createAgentTurnReconciler(options) {
  let pollMs = options.pollMs ?? DEFAULT_RECONCILE_POLL_MS
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const clearSchedule = options.clearSchedule || ((id) => clearTimeout(id))

  let generation = 0
  let projectId = null
  let expectedTurnId = null
  let turnPhase = 'idle'
  let polling = false
  let inFlight = false
  let timer = null
  let requestCount = 0
  let terminalCount = 0
  let terminalReported = false
  let startPending = false
  let startTimedOut = false
  let onActive = options.onActive || null
  let onTerminal = options.onTerminal || null
  let onOrphaned = options.onOrphaned || null

  const clearTimer = () => {
    if (timer == null) return
    clearSchedule(timer)
    timer = null
  }

  const armPoll = () => {
    if (!polling || timer != null || inFlight || !projectId) return
    timer = schedule(() => {
      timer = null
      if (!polling) return
      reconcileNow()
    }, pollMs)
  }

  const finishInFlight = (gen) => {
    inFlight = false
    if (!polling || !projectId) return
    if (gen !== generation) {
      Promise.resolve(reconcileNow())
      return
    }
    armPoll()
  }

  async function reconcileNow(overrides = {}) {
    if (Object.prototype.hasOwnProperty.call(overrides, 'startPending')) {
      startPending = Boolean(overrides.startPending)
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'startTimedOut')) {
      startTimedOut = Boolean(overrides.startTimedOut)
    }
    if (!projectId) return { outcome: 'idle' }
    if (inFlight) return { outcome: 'busy' }
    const gen = generation
    const id = projectId
    inFlight = true
    requestCount += 1
    try {
      const run = await options.fetchRun(id)
      if (gen !== generation || id !== projectId) return { outcome: 'stale' }
      const status = run?.status || 'idle'
      if (isActiveChatRunStatus(status)) {
        onActive?.(run)
        return { outcome: 'active', run }
      }
      const runKind = classifyChatRun({
        run,
        currentTurnId: expectedTurnId,
        turnPhase,
        startPending,
        startTimedOut,
      })
      if (runKind === 'ignore-pending-bind' || runKind === 'stale') {
        return { outcome: runKind, run }
      }
      if (runKind === 'orphaned') {
        polling = false
        clearTimer()
        try {
          await onOrphaned?.(run)
        } catch (error) {
          return { outcome: 'orphaned', run, error }
        }
        return { outcome: 'orphaned', run }
      }
      if (terminalReported) return { outcome: 'terminal', run, duplicate: true }
      terminalReported = true
      polling = false
      clearTimer()
      try {
        const applied = await onTerminal?.(run)
        if (applied === false) {
          terminalReported = false
          polling = true
          return { outcome: 'retry', run }
        }
      } catch (error) {
        terminalReported = false
        polling = true
        return { outcome: 'error', error }
      }
      terminalCount += 1
      return { outcome: 'terminal', run }
    } catch (error) {
      if (gen !== generation || id !== projectId) return { outcome: 'stale' }
      return { outcome: 'error', error }
    } finally {
      finishInFlight(gen)
    }
  }

  function configure(next = {}) {
    const nextProjectId = Object.prototype.hasOwnProperty.call(next, 'projectId')
      ? (next.projectId ?? null)
      : projectId
    const nextTurnId = Object.prototype.hasOwnProperty.call(next, 'expectedTurnId')
      ? (next.expectedTurnId ?? null)
      : expectedTurnId
    if (Object.prototype.hasOwnProperty.call(next, 'turnPhase')) {
      turnPhase = next.turnPhase || 'idle'
    }
    if (Object.prototype.hasOwnProperty.call(next, 'pollMs') && next.pollMs) {
      pollMs = next.pollMs
    }
    const nextPolling = Boolean(next.polling && nextProjectId)
    if ('onActive' in next) onActive = next.onActive
    if ('onTerminal' in next) onTerminal = next.onTerminal
    if ('onOrphaned' in next) onOrphaned = next.onOrphaned
    const nextStartPending = Object.prototype.hasOwnProperty.call(next, 'startPending')
      ? Boolean(next.startPending)
      : startPending
    const nextStartTimedOut = Object.prototype.hasOwnProperty.call(next, 'startTimedOut')
      ? Boolean(next.startTimedOut)
      : startTimedOut

    const projectChanged = nextProjectId !== projectId
    const turnChanged = nextTurnId !== expectedTurnId
    const bindWindowChanged = nextStartPending !== startPending || nextStartTimedOut !== startTimedOut
    if (projectChanged || turnChanged) {
      generation += 1
      terminalReported = false
      clearTimer()
    } else if (bindWindowChanged) {
      generation += 1
      clearTimer()
    }

    const pollingStarted = nextPolling && (
      !polling || projectChanged || turnChanged || bindWindowChanged
    )
    projectId = nextProjectId
    expectedTurnId = nextTurnId
    startPending = nextStartPending
    startTimedOut = nextStartTimedOut
    polling = nextPolling

    if (!polling) {
      clearTimer()
      return
    }
    if (pollingStarted && !inFlight) {
      clearTimer()
      Promise.resolve(reconcileNow())
      return
    }
    armPoll()
  }

  function dispose() {
    generation += 1
    polling = false
    inFlight = false
    terminalReported = false
    projectId = null
    expectedTurnId = null
    clearTimer()
  }

  function snapshot() {
    return {
      generation,
      projectId,
      expectedTurnId,
      turnPhase,
      polling,
      inFlight,
      requestCount,
      terminalCount,
      startPending,
      startTimedOut,
    }
  }

  return { configure, reconcileNow, dispose, snapshot }
}

/**
 * 在停止中轮询 /chat/run，并在 SSE ready 时提供立即校准。
 *
 * @param {object} props
 * @param {string|null} props.projectId 当前已订阅 SSE 的项目。
 * @param {string} props.turnPhase 前端回合相位。
 * @param {string|null} [props.expectedTurnId] 当前前端记住的回合 id。
 * @param {boolean} [props.settlementRetry] 终态对账失败后继续询问 /chat/run。
 * @param {boolean} [props.startPending] POST /chat 是否仍在等待响应。
 * @param {boolean} [props.startTimedOut] 启动绑定窗口是否已超时。
 * @param {(projectId: string) => Promise<object>} props.fetchRun
 * @param {(run: object) => void} props.onActive
 * @param {(run: object) => void|Promise<void>} props.onTerminal
 * @param {(run: object) => void|Promise<void>} [props.onOrphaned]
 * @param {number} [props.pollMs]
 * @returns {{reconcileNow: Function}}
 */
export function useAgentTurnReconciliation({
  projectId,
  turnPhase,
  expectedTurnId = null,
  settlementRetry = false,
  startPending = false,
  startTimedOut = false,
  fetchRun,
  onActive,
  onTerminal,
  onOrphaned,
  pollMs = DEFAULT_RECONCILE_POLL_MS,
}) {
  const fetchRunRef = useRef(fetchRun)
  fetchRunRef.current = fetchRun
  const onActiveRef = useRef(onActive)
  onActiveRef.current = onActive
  const onTerminalRef = useRef(onTerminal)
  onTerminalRef.current = onTerminal
  const onOrphanedRef = useRef(onOrphaned)
  onOrphanedRef.current = onOrphaned

  const reconcilerRef = useRef(null)
  if (!reconcilerRef.current) {
    reconcilerRef.current = createAgentTurnReconciler({
      fetchRun: (id) => fetchRunRef.current(id),
      onActive: (run) => onActiveRef.current?.(run),
      onTerminal: (run) => onTerminalRef.current?.(run),
      onOrphaned: (run) => onOrphanedRef.current?.(run),
      pollMs,
    })
  }

  useEffect(() => {
    reconcilerRef.current.configure({
      projectId,
      expectedTurnId,
      turnPhase,
      startPending,
      startTimedOut,
      polling: Boolean(projectId) && shouldPollChatRun(turnPhase, settlementRetry),
      pollMs: chatRunPollMs(turnPhase, settlementRetry),
    })
  }, [projectId, expectedTurnId, turnPhase, settlementRetry, startPending, startTimedOut])

  useEffect(() => () => {
    reconcilerRef.current?.dispose()
  }, [])

  return {
    reconcileNow: (overrides) => reconcilerRef.current.reconcileNow(overrides),
  }
}
