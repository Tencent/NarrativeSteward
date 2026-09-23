/**
 * 项目内容刷新协调：合并短时间内对同一片段的重复请求，并区分预览与正式更新。
 * 预览提示必须与正文加载结果一致，见 DESIGN §6.7。
 */

const DEFAULT_DELAY_MS = 200

/** 首次读取失败后最多再试几次。 */
export const PREVIEW_RETRY_LIMIT = 2

/** 预览重试间隔（毫秒）。 */
export const PREVIEW_RETRY_DELAY_MS = 400

/** 预览条按片段记录的状态。 */
export const PREVIEW_STATUS = {
  loading: 'loading',
  ready: 'ready',
  retrying: 'retrying',
  failed: 'failed',
}

/**
 * 生成刷新键：普通片段用 data_type，情节用 scene:eventId。
 * @param {string} dataType 片段类型。
 * @param {string} [eventId] 情节事件 id。
 * @returns {string}
 */
export function refreshKey(dataType, eventId) {
  if (dataType === 'scenes' && eventId) return `scene:${eventId}`
  return dataType || 'unknown'
}

/**
 * 同一预览 bundle 的重试键：按项目、回合和检查点代次隔离，不得跨代累计失败。
 * @param {string} projectId
 * @param {string} turnId
 * @param {number} generation
 * @returns {string}
 */
export function previewBundleRetryKey(projectId, turnId, generation) {
  return `${projectId}:${turnId}:${generation}`
}

/**
 * 创建可在 React 外测试的刷新调度器。
 * @param {{now?: () => number, delayMs?: number}} [options]
 * @returns {{schedule: Function, flush: Function, pendingKeys: Function, cancel: Function}}
 */
export function createRefreshCoordinator(options = {}) {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const now = options.now || (() => Date.now())
  const timers = new Map()
  const payloads = new Map()

  const flushKey = (key) => {
    const item = payloads.get(key)
    timers.delete(key)
    payloads.delete(key)
    if (item) item.run(item.payload)
  }

  return {
    schedule(key, payload, run) {
      payloads.set(key, { payload, run })
      if (timers.has(key)) return
      const handle = setTimeout(() => flushKey(key), delayMs)
      timers.set(key, handle)
    },
    flush(key) {
      if (key) {
        const handle = timers.get(key)
        if (handle) clearTimeout(handle)
        flushKey(key)
        return
      }
      for (const pendingKey of [...payloads.keys()]) {
        const handle = timers.get(pendingKey)
        if (handle) clearTimeout(handle)
        flushKey(pendingKey)
      }
    },
    pendingKeys() {
      return [...payloads.keys()]
    },
    cancel() {
      for (const handle of timers.values()) clearTimeout(handle)
      timers.clear()
      payloads.clear()
    },
    now,
  }
}

/**
 * 预览刷新不得覆盖未保存草稿。
 * @param {Record<string, boolean>} dirtyMap
 * @param {string} key
 * @returns {boolean}
 */
export function shouldSkipDirtyPreview(dirtyMap, key) {
  return Boolean(dirtyMap?.[key])
}

/**
 * 根据一次片段读取结果决定预览条状态，以及是否继续重试。
 * 被更晚请求取代的响应视为 stale：不覆盖新内容，也不再为这一次失败排队。
 *
 * @param {'applied'|'stale'|'failed'|string} result loadFragment 的结果。
 * @param {number} [failureCount] 本键已经失败的次数。
 * @returns {{status: string|null, failureCount: number, retry: boolean, keep: boolean}}
 */
export function applyPreviewLoadResult(result, failureCount = 0) {
  if (result === 'applied') {
    return { status: PREVIEW_STATUS.ready, failureCount: 0, retry: false, keep: false }
  }
  if (result === 'stale') {
    return { status: null, failureCount, retry: false, keep: true }
  }
  if (result === 'failed') {
    const nextCount = failureCount + 1
    if (nextCount <= PREVIEW_RETRY_LIMIT) {
      return {
        status: PREVIEW_STATUS.retrying,
        failureCount: nextCount,
        retry: true,
        keep: false,
      }
    }
    return {
      status: PREVIEW_STATUS.failed,
      failureCount: nextCount,
      retry: false,
      keep: false,
    }
  }
  return { status: null, failureCount, retry: false, keep: true }
}

/**
 * 预览条文案。加载成功前不宣称预览已显示。
 *
 * @param {string|null|undefined} status
 * @returns {string|null}
 */
export function previewBannerMessage(status, t) {
  const text = (key) => (t ? t(key) : ({
    'agent.preview.loading': '正在加载本轮生成预览',
    'agent.preview.unpublished': '本轮生成预览，尚未正式提交',
    'agent.preview.retryLater': '本轮生成预览暂时没能同步，将在回合结束时重新读取',
  }[key]))
  if (status === PREVIEW_STATUS.loading || status === PREVIEW_STATUS.retrying) {
    return text('agent.preview.loading')
  }
  if (status === PREVIEW_STATUS.ready) {
    return text('agent.preview.unpublished')
  }
  if (status === PREVIEW_STATUS.failed) {
    return text('agent.preview.retryLater')
  }
  return null
}

/**
 * 合并多个片段的预览状态：优先报告仍在加载或重试，避免把局部失败说成已就绪。
 *
 * @param {Record<string, string>} previewMap
 * @param {string[]} keys
 * @returns {string|null}
 */
export function combinedPreviewStatus(previewMap, keys) {
  const statuses = (keys || []).map((key) => previewMap?.[key]).filter(Boolean)
  if (statuses.includes(PREVIEW_STATUS.loading)) return PREVIEW_STATUS.loading
  if (statuses.includes(PREVIEW_STATUS.retrying)) return PREVIEW_STATUS.retrying
  if (statuses.includes(PREVIEW_STATUS.ready)) return PREVIEW_STATUS.ready
  if (statuses.includes(PREVIEW_STATUS.failed)) return PREVIEW_STATUS.failed
  return null
}

/**
 * 事件阶段共用提示条所覆盖的预览键：事件图本身，以及按事件刷新的情节。
 *
 * @param {Record<string, string>} previewMap
 * @returns {string[]}
 */
export function eventStagePreviewKeys(previewMap) {
  return Object.keys(previewMap || {}).filter(
    (key) => key === 'events' || key.startsWith('scene:'),
  )
}

/**
 * 创建可在 React 外测试的预览重试控制器。
 * 新一轮预览或终态清理会抬升代次，使旧定时器不再执行。
 *
 * @param {{delayMs?: number, schedule?: Function, clearSchedule?: Function}} [options]
 * @returns {{begin: Function, schedule: Function, isCurrent: Function, cancel: Function, pendingKeys: Function}}
 */
export function createPreviewRetryController(options = {}) {
  const delayMs = options.delayMs ?? PREVIEW_RETRY_DELAY_MS
  const scheduleTimer = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const clearSchedule = options.clearSchedule || ((id) => clearTimeout(id))
  const timers = new Map()
  const generations = new Map()

  const bump = (key) => {
    const generation = (generations.get(key) || 0) + 1
    generations.set(key, generation)
    return generation
  }

  const clearTimer = (key) => {
    const handle = timers.get(key)
    if (handle == null) return
    clearSchedule(handle)
    timers.delete(key)
  }

  return {
    /**
     * 开始一次新的读取，作废该键尚未执行的重试。
     * @param {string} key
     * @returns {number} 新代次。
     */
    begin(key) {
      clearTimer(key)
      return bump(key)
    },
    /**
     * 在延迟后执行一次重试；同键后一次调度取代前一次。
     * @param {string} key
     * @param {Function} run
     * @returns {number}
     */
    schedule(key, run) {
      clearTimer(key)
      const generation = bump(key)
      const handle = scheduleTimer(() => {
        timers.delete(key)
        if (generations.get(key) !== generation) return
        run({ key, generation })
      }, delayMs)
      timers.set(key, handle)
      return generation
    },
    /**
     * 判断回调是否仍属于当前代次。
     * @param {string} key
     * @param {number} generation
     * @returns {boolean}
     */
    isCurrent(key, generation) {
      return generations.get(key) === generation
    },
    /**
     * 取消一个键或全部键的待执行重试。
     * @param {string} [key]
     */
    cancel(key) {
      if (key) {
        clearTimer(key)
        bump(key)
        return
      }
      for (const pending of [...timers.keys()]) clearTimer(pending)
      for (const existing of [...generations.keys()]) bump(existing)
    },
    pendingKeys() {
      return [...timers.keys()]
    },
  }
}

/**
 * 按整个预览代次管理请求：旧代次、新回合和已撤销代次都不得覆盖界面。
 *
 * @returns {{begin: Function, isCurrent: Function, revoke: Function, isRevoked: Function, cancel: Function}}
 */
export function createGenerationPreviewController() {
  let current = { projectId: null, turnId: null, generation: 0 }
  const revoked = new Set()
  let token = 0

  const keyOf = (turnId, generation) => `${turnId}:${generation}`

  return {
    /**
     * 开始加载一个代次，返回本次请求 token。
     * @param {string} projectId
     * @param {string} turnId
     * @param {number} generation
     * @returns {number}
     */
    begin(projectId, turnId, generation) {
      token += 1
      current = { projectId, turnId, generation }
      return token
    },
    /**
     * 判断响应是否仍属于当前项目/回合/代次。
     * @param {string} projectId
     * @param {string} turnId
     * @param {number} generation
     * @param {number} requestToken
     * @returns {boolean}
     */
    isCurrent(projectId, turnId, generation, requestToken) {
      return (
        requestToken === token
        && current.projectId === projectId
        && current.turnId === turnId
        && current.generation === generation
      )
    },
    /**
     * 标记某代次已撤销。
     * @param {string} turnId
     * @param {number} generation
     */
    revoke(turnId, generation) {
      revoked.add(keyOf(turnId, generation))
    },
    /**
     * 代次是否已撤销。
     * @param {string} turnId
     * @param {number} generation
     * @returns {boolean}
     */
    isRevoked(turnId, generation) {
      return revoked.has(keyOf(turnId, generation))
    },
    /**
     * 取消在途代次（停止、失败或正式完成后调用）。
     */
    cancel() {
      token += 1
      current = { projectId: null, turnId: null, generation: 0 }
    },
  }
}
