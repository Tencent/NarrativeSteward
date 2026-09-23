/**
 * 事件网络与情节网络的连续呈现：旧快照保持可见，新快照校验后代次提交。
 */

import { eventGraphFitAction, graphTopologyKey } from './graphUtils.js'
import { tZh } from './i18n/translate.js'

/**
 * 图是否含有可显示的节点。事件图看 nodes，情节图看 beats。
 *
 * @param {object|null|undefined} graph
 * @returns {boolean}
 */
export function hasGraphContent(graph) {
  if (!graph) return false
  const nodes = graph.nodes || graph.beats || []
  return nodes.length > 0
}

/**
 * 从候选与上一份可用快照中选出当前应显示的图，并给出呈现相位。
 *
 * @param {object|null} lastGood 上一份非空可用快照。
 * @param {object|null} candidate 本次读取到的候选。
 * @param {object} [context]
 * @param {boolean} [context.loading]
 * @param {boolean} [context.failed]
 * @param {boolean} [context.generating]
 * @param {boolean} [context.authoritative] 本次是权威读取（终态对账、手动保存、初次加载）。
 * @param {boolean} [context.confirmedEmpty] 权威结果确认当前没有图。
 * @returns {{displayed: object|null, lastGood: object|null, phase: string}}
 */
export function selectDisplayedGraph(lastGood, candidate, {
  loading = false,
  failed = false,
  generating = false,
  authoritative = false,
  confirmedEmpty = false,
} = {}) {
  const lastHas = hasGraphContent(lastGood)
  const candidateHas = hasGraphContent(candidate)

  if (confirmedEmpty && authoritative && !generating) {
    return { displayed: candidate ?? null, lastGood: null, phase: 'confirmed_empty' }
  }
  if (candidateHas) {
    return {
      displayed: candidate,
      lastGood: candidate,
      phase: loading || generating ? 'refreshing' : 'stable',
    }
  }
  if (lastHas) {
    if (failed) return { displayed: lastGood, lastGood, phase: 'stale_error' }
    if (loading || generating || !authoritative) {
      return { displayed: lastGood, lastGood, phase: 'refreshing' }
    }
    return { displayed: lastGood, lastGood, phase: 'stable' }
  }
  if (loading) return { displayed: lastGood ?? null, lastGood: lastGood ?? null, phase: 'initial_loading' }
  if (generating) {
    return { displayed: lastGood ?? null, lastGood: lastGood ?? null, phase: 'generating_empty' }
  }
  if (failed) return { displayed: lastGood ?? null, lastGood: lastGood ?? null, phase: 'stale_error' }
  return { displayed: candidate ?? lastGood ?? null, lastGood: lastGood ?? null, phase: 'stable' }
}

/**
 * 覆盖层文案：有上一份图时说明正在刷新或失败重试，没有图时说明首次生成。
 *
 * @param {string} phase
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {string|null}
 */
export function graphOverlayText(phase, t = tZh) {
  if (phase === 'refreshing') return t('workspace.graphBusy.refreshing')
  if (phase === 'stale_error') return t('workspace.graphBusy.retrying')
  if (phase === 'generating_empty') return t('workspace.graphBusy.generating')
  if (phase === 'initial_loading') return t('workspace.graphBusy.loading')
  return null
}

/**
 * 尺寸观察只在画布从隐藏/无有效尺寸变为可见时触发一次恢复适配。
 *
 * 普通问答开始或结束、提示条增减、滚动条变化都可能让容器尺寸轻微改变；这些变化不得
 * 重置创作者的平移与缩放，也不得在 React Flow 正在同步节点时把视口适配到空区域。
 *
 * @param {{width?: number, height?: number}|null} previous 上一次测得的画布尺寸。
 * @param {{width?: number, height?: number}|null} current 当前画布尺寸。
 * @param {number} [minimumSize] 判定可见的最小宽高。
 * @returns {boolean} 是否需要执行一次可见性恢复适配。
 */
export function shouldFitAfterCanvasBecomesVisible(previous, current, minimumSize = 100) {
  const wasVisible = Boolean(
    previous
    && previous.width > minimumSize
    && previous.height > minimumSize,
  )
  const isVisible = Boolean(
    current
    && current.width > minimumSize
    && current.height > minimumSize,
  )
  return !wasVisible && isVisible
}

/**
 * 按资源键递增的 latest-wins 代次。切项目或切事件后丢掉迟到响应。
 *
 * @returns {{begin: Function, isCurrent: Function, reset: Function, peek: Function}}
 */
export function createLatestWinsMap() {
  const generations = new Map()

  return {
    /**
     * @param {string} key
     * @returns {number}
     */
    begin(key) {
      const next = (generations.get(key) || 0) + 1
      generations.set(key, next)
      return next
    },
    /**
     * @param {string} key
     * @param {number} generation
     * @returns {boolean}
     */
    isCurrent(key, generation) {
      return generations.get(key) === generation
    },
    /**
     * @param {string} [prefix] 不传则清空全部。
     */
    reset(prefix) {
      if (prefix == null) {
        generations.clear()
        return
      }
      for (const key of [...generations.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(prefix)) {
          generations.delete(key)
        }
      }
    },
    peek(key) {
      return generations.get(key) || 0
    },
  }
}

/**
 * 拓扑变化后的视口调度：同一拓扑只保留一次待执行适配，完成 fit 后才登记指纹。
 *
 * @param {object} [options]
 * @param {(fn: Function, ms: number) => *} [options.schedule]
 * @param {(id: *) => void} [options.clearSchedule]
 * @param {(fn: Function) => *} [options.raf]
 * @param {(id: *) => void} [options.cancelRaf]
 * @param {number} [options.delayMs]
 */
export function createViewportFitScheduler(options = {}) {
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const clearSchedule = options.clearSchedule || ((id) => clearTimeout(id))
  const raf = options.raf || ((fn) => (
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0)
  ))
  const cancelRaf = options.cancelRaf || ((id) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    else clearTimeout(id)
  })
  const delayMs = options.delayMs ?? 120

  let pendingKey = null
  let fittedKey = ''
  let timer = null
  let frame = null

  const clearPendingTimers = () => {
    if (timer != null) {
      clearSchedule(timer)
      timer = null
    }
    if (frame != null) {
      cancelRaf(frame)
      frame = null
    }
  }

  /**
   * 取消尚未执行的适配，不改已完成的指纹。
   */
  function cancel() {
    clearPendingTimers()
    pendingKey = null
  }

  /**
   * 清空指纹与待执行任务，切项目或切事件时使用。
   */
  function reset() {
    cancel()
    fittedKey = ''
  }

  /**
   * @param {object} input
   * @param {string} input.topologyKey
   * @param {boolean} [input.firstAppearance]
   * @param {(done: Function) => void} input.fit 执行铺满；完成后必须调用 done()。
   * @returns {string} eventGraphFitAction 的结果。
   */
  function requestFit({ topologyKey, firstAppearance = false, fit }) {
    const action = eventGraphFitAction({
      topologyKey,
      fittedKey,
      pendingKey,
      firstAppearance,
    })
    if (
      action === 'skip-empty'
      || action === 'already-fitted'
      || action === 'keep-pending'
      || action === 'defer-initial'
    ) {
      return action
    }
    if (pendingKey && pendingKey !== topologyKey) clearPendingTimers()
    pendingKey = topologyKey
    const scheduledKey = topologyKey
    timer = schedule(() => {
      timer = null
      frame = raf(() => {
        frame = null
        if (pendingKey !== scheduledKey) return
        fit(() => {
          if (pendingKey === scheduledKey || pendingKey == null) {
            fittedKey = scheduledKey
            if (pendingKey === scheduledKey) pendingKey = null
          }
        })
      })
    }, delayMs)
    return 'schedule'
  }

  /**
   * 首次视口或人工适应完成后登记指纹。
   * @param {string} topologyKey
   */
  function markFitted(topologyKey) {
    if (!topologyKey || topologyKey === '|') return
    fittedKey = topologyKey
    if (pendingKey === topologyKey) pendingKey = null
  }

  function snapshot() {
    return { pendingKey, fittedKey }
  }

  return { requestFit, markFitted, reset, cancel, snapshot, topologyKey: graphTopologyKey }
}
