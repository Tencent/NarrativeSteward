/**
 * Agent 回合终态页面对账：用 project_id + turn_id 记录一轮是否已经把历史和内容装进当前页面。
 * idle / busy=false 只表示当前没有正在执行的回合，不能代替对账。
 */

/**
 * 生成一轮终态对账键。
 *
 * @param {string|null|undefined} projectId 当前项目。
 * @param {string|null|undefined} turnId 后台回合 id。
 * @returns {string|null} 对账键；缺任一项时为 null。
 */
export function turnSettlementKey(projectId, turnId) {
  if (!projectId || !turnId) return null
  return `${projectId}:${turnId}`
}

/**
 * 判断这次终态通知是否应启动新的页面对账。
 *
 * 无 turn_id 的匿名 idle 不刷新。已对账的同一回合直接跳过。正在对账的同一回合应由调用方
 * 等待已有 Promise，而不是再开一次读取。
 *
 * @param {object} options
 * @param {string|null|undefined} options.projectId
 * @param {string|null|undefined} options.turnId
 * @param {string|null|undefined} [options.status] /chat/run 或 SSE 状态。
 * @param {string|null} [options.settledKey] 最近成功对账的键。
 * @param {string|null} [options.settlingKey] 正在对账的键。
 * @returns {'skip-anonymous'|'skip-settled'|'join-in-flight'|'start'}
 */
export function terminalSettlementAction({
  projectId,
  turnId,
  status = null,
  settledKey = null,
  settlingKey = null,
} = {}) {
  if (!projectId) return 'skip-anonymous'
  if (!turnId) return 'skip-anonymous'
  if (status === 'running' || status === 'stop_requested' || status === 'completing') {
    return 'skip-anonymous'
  }
  const key = turnSettlementKey(projectId, turnId)
  if (!key) return 'skip-anonymous'
  if (settledKey === key) return 'skip-settled'
  if (settlingKey === key) return 'join-in-flight'
  return 'start'
}

/**
 * 判断校准器是否应继续询问 /chat/run。
 *
 * 活动回合全程校准，避免漏收 turn_end 后永久卡在 completing。
 *
 * @param {string} turnPhase 前端回合相位。
 * @param {boolean} settlementRetry 最近一次终态对账失败、需要再问 /chat/run。
 * @returns {boolean}
 */
export function shouldPollChatRun(turnPhase, settlementRetry) {
  return (
    turnPhase === 'running'
    || turnPhase === 'stop_requested'
    || turnPhase === 'completing'
    || turnPhase === 'stopped'
    || Boolean(settlementRetry)
  )
}

/** 生成中低频校准间隔（毫秒）。 */
export const ACTIVE_CHAT_RUN_POLL_MS = 2500

/** 停止中、收口中或尚未对账时的校准间隔（毫秒）。 */
export const TERMINAL_CHAT_RUN_POLL_MS = 750

/**
 * 按当前相位选择 /chat/run 轮询间隔。
 *
 * @param {string} turnPhase
 * @param {boolean} settlementRetry
 * @returns {number}
 */
export function chatRunPollMs(turnPhase, settlementRetry) {
  if (turnPhase === 'running' && !settlementRetry) return ACTIVE_CHAT_RUN_POLL_MS
  return TERMINAL_CHAT_RUN_POLL_MS
}

/**
 * 判断带 turn_id 的 SSE 通知属于当前回合、过期回合，还是尚未绑定。
 *
 * @param {object} options
 * @param {string|null|undefined} [options.eventTurnId] 通知里的回合 id。
 * @param {string|null|undefined} [options.currentTurnId] 前端已绑定的回合 id。
 * @returns {'current'|'stale'|'unknown'}
 */
export function classifyTurnEvent({ eventTurnId = null, currentTurnId = null } = {}) {
  if (!eventTurnId) return 'unknown'
  if (!currentTurnId) return 'unknown'
  if (eventTurnId === currentTurnId) return 'current'
  return 'stale'
}

/**
 * 判定过程事件（agent_text / tool_* / budget / status / error）是否可写入当前助手气泡。
 *
 * 未知身份一律先校准、不覆盖当前气泡；只有已绑定且 id 一致才应用。
 *
 * @param {object} [options]
 * @param {string|null|undefined} [options.eventTurnId]
 * @param {string|null|undefined} [options.currentTurnId]
 * @returns {'current'|'stale'|'pending-bind'}
 */
export function classifyProcessEvent({ eventTurnId = null, currentTurnId = null } = {}) {
  if (eventTurnId && currentTurnId && eventTurnId === currentTurnId) return 'current'
  if (eventTurnId && currentTurnId && eventTurnId !== currentTurnId) return 'stale'
  return 'pending-bind'
}

/** POST /chat 发出后，等待 turn_id 绑定的最长时间（毫秒）。 */
export const TURN_START_BIND_TIMEOUT_MS = 8000

/**
 * 当前是否仍处于启动绑定窗口：POST 尚未返回，且尚未超时。
 *
 * @param {object} [options]
 * @param {boolean} [options.startPending] POST /chat 是否仍在等待响应。
 * @param {boolean} [options.startTimedOut] 绑定窗口是否已超时。
 * @returns {boolean}
 */
export function isStartBindPending({ startPending = false, startTimedOut = false } = {}) {
  return Boolean(startPending) && !startTimedOut
}

/**
 * 本地正等待启动且尚未绑定 turn_id 时，是否应直接采用 SSE turn_start 的 id。
 *
 * @param {object} [options]
 * @param {string|null} [options.eventTurnId]
 * @param {string|null} [options.currentTurnId]
 * @param {boolean} [options.startPending]
 * @returns {boolean}
 */
export function shouldBindUnknownTurnStart({
  eventTurnId = null,
  currentTurnId = null,
  startPending = false,
} = {}) {
  return Boolean(eventTurnId) && !currentTurnId && Boolean(startPending)
}

/**
 * 判断这次 /chat/run 结果应同步活动相位、进入终态恢复，还是忽略。
 *
 * 启动绑定窗口内（POST 尚未返回且未超时），后端可能仍报告上一轮 completed / idle。
 * 这时不能把匿名 idle 当成当前回合结束。窗口结束后仍无 turn_id，且后端不是活动状态，
 * 则视为幽灵运行，必须恢复正式页面。
 *
 * @param {object} options
 * @param {object|null} [options.run]
 * @param {string|null|undefined} [options.currentTurnId]
 * @param {string} [options.turnPhase]
 * @param {boolean} [options.startPending] POST /chat 是否仍在等待响应。
 * @param {boolean} [options.startTimedOut] 绑定窗口是否已超时。
 * @returns {'active'|'terminal'|'ignore-pending-bind'|'stale'|'orphaned'}
 */
export function classifyChatRun({
  run = null,
  currentTurnId = null,
  turnPhase = 'idle',
  startPending = false,
  startTimedOut = false,
} = {}) {
  const status = run?.status || 'idle'
  const runTurnId = run?.turn_id || null
  if (status === 'running' || status === 'stop_requested' || status === 'completing') {
    return 'active'
  }
  const awaitingBind = !currentTurnId && (
    turnPhase === 'running' || turnPhase === 'completing' || turnPhase === 'stop_requested'
  )
  if (awaitingBind) {
    if (isStartBindPending({ startPending, startTimedOut })) return 'ignore-pending-bind'
    return 'orphaned'
  }
  if (currentTurnId && runTurnId && runTurnId !== currentTurnId) return 'stale'
  return 'terminal'
}

/**
 * 当前回合是否仍应接受生成预览。停止与回滚过程中保留旧图，不再装入将被撤销的内容。
 *
 * @param {string} turnPhase
 * @returns {boolean}
 */
export function shouldAcceptPreview(turnPhase) {
  return turnPhase === 'running' || turnPhase === 'completing'
}

/**
 * 按 project_id + turn_id 去重、可重试、防迟到覆盖的终态快照控制器。
 *
 * loadAndApply 成功提交当前页面后返回 true；切项目或换回合后返回 false，不登记已对账；
 * 必要读取失败必须 throw，保留未对账以便下一次校准重试。
 *
 * @returns {{
 *   beginNewTurn: Function,
 *   markSettled: Function,
 *   snapshot: Function,
 *   restore: Function,
 * }}
 */
export function createTerminalTurnSettlement() {
  let settledKey = null
  let settlingKey = null
  let inFlight = null

  /**
   * 开始新回合或切走项目时丢掉上一轮对账状态。
   */
  function beginNewTurn() {
    settledKey = null
    settlingKey = null
    inFlight = null
  }

  /**
   * 初次打开项目已完整读取过该终态回合后，登记已对账，避免随后的 ready 再刷一遍。
   *
   * @param {string} projectId
   * @param {string} turnId
   */
  function markSettled(projectId, turnId) {
    const key = turnSettlementKey(projectId, turnId)
    if (key) settledKey = key
  }

  /**
   * @returns {{settledKey: string|null, settlingKey: string|null, busy: boolean}}
   */
  function snapshot() {
    return {
      settledKey,
      settlingKey,
      busy: Boolean(inFlight),
    }
  }

  /**
   * 按当前回合执行一次终态恢复，或等待/跳过重复通知。
   *
   * @param {object} input
   * @param {string|null|undefined} input.projectId
   * @param {string|null|undefined} input.turnId
   * @param {string|null|undefined} [input.status]
   * @param {() => Promise<boolean>} input.loadAndApply
   * @returns {Promise<{action: string, applied?: boolean, key?: string|null}>}
   */
  async function restore({ projectId, turnId, status = null, loadAndApply }) {
    const action = terminalSettlementAction({
      projectId,
      turnId,
      status,
      settledKey,
      settlingKey,
    })
    if (action === 'skip-anonymous' || action === 'skip-settled') {
      return { action }
    }
    if (action === 'join-in-flight') {
      if (inFlight) await inFlight
      return { action }
    }

    const key = turnSettlementKey(projectId, turnId)
    settlingKey = key
    const work = (async () => {
      try {
        const applied = await loadAndApply()
        if (applied) settledKey = key
        return { action: 'start', applied: Boolean(applied), key }
      } finally {
        if (settlingKey === key) settlingKey = null
      }
    })()
    inFlight = work
    try {
      return await work
    } finally {
      if (inFlight === work) inFlight = null
    }
  }

  return { beginNewTurn, markSettled, snapshot, restore }
}
