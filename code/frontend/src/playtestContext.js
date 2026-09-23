/**
 * 试玩情景快照：把浏览器内存中的当前位置、实际边路线和变量编成聊天请求。
 * 见 DESIGN §5.6.1。正文与未选分支由服务端按正式项目图重放还原。
 */

/** 可以附带试玩情景的试玩相位。 */
export const PLAYTEST_ATTACHABLE_STATUSES = Object.freeze([
  'playing',
  'dead_end',
  'blocked',
  'ending',
])

/**
 * 根据试玩状态和当前选项推断发送时的相位。
 *
 * @param {string} status 试玩引擎状态。
 * @param {Array<{kind?: string}>} [choices] 当前画面选项。
 * @returns {string} 相位名。
 */
export function inferPlaytestPhase(status, choices = []) {
  if (status === 'ending' || status === 'blocked' || status === 'idle' || status === 'loading' || status === 'error') {
    return status
  }
  const kinds = new Set((choices || []).map((choice) => choice.kind))
  if (kinds.has('event_boundary')) return 'event_boundary'
  if (kinds.has('event')) return 'event_transition'
  if (status === 'dead_end') return 'dead_end'
  return 'scene'
}

/**
 * 记录一条真实经过的图边。
 *
 * @param {Array<{kind: string, edge_id: string}>} edges 已有路线。
 * @param {'scene'|'event'} kind 边所在层。
 * @param {string} edgeId 稳定边 id。
 * @returns {Array<{kind: string, edge_id: string}>} 追加后的新数组；缺 id 时原样返回。
 */
export function recordTakenEdge(edges, kind, edgeId) {
  if (!edgeId || (kind !== 'scene' && kind !== 'event')) return edges || []
  return [...(edges || []), { kind, edge_id: String(edgeId) }]
}

/**
 * 当前画面里可精确引用的真实边 id。
 *
 * @param {Array<{kind?: string, edge?: {id?: string}}>} [choices]
 * @returns {string[]}
 */
export function playtestCitableEdgeIds(choices = []) {
  return (choices || [])
    .filter((choice) => choice.kind !== 'event_boundary' && choice.edge?.id)
    .map((choice) => String(choice.edge.id))
}

/**
 * 判断这次发送是否应附带试玩情景。
 *
 * @param {object} input
 * @param {'build'|'playtest'} [input.board] 当前中间板块。
 * @param {boolean} [input.mustRestart] 本局是否已因正式内容变化过期。
 * @param {string} [input.status] 试玩状态。
 * @param {string} [input.eventId] 当前位置事件 id。
 * @returns {boolean}
 */
export function shouldAttachPlaytestContext({
  board = 'build',
  mustRestart = false,
  status = 'idle',
  eventId = '',
} = {}) {
  return (
    board === 'playtest'
    && !mustRestart
    && PLAYTEST_ATTACHABLE_STATUSES.includes(status)
    && Boolean(eventId)
  )
}

/**
 * 当前位置：优先用引擎显式维护的对象，否则从最近一条 beat 或阻断事件还原。
 *
 * @param {{event_id?: string, beat_id?: string, location_id?: string, speaker_id?: string}|null} current
 * @param {Array<{kind?: string, eventId?: string, beat?: object}>} [history]
 * @param {{id?: string}|null} [blockedEvent]
 * @returns {{event_id: string, beat_id: string, location_id: string, speaker_id: string}}
 */
export function resolvePlaytestCurrent(current, history = [], blockedEvent = null) {
  if (current?.event_id) {
    return {
      event_id: String(current.event_id),
      beat_id: String(current.beat_id || ''),
      location_id: String(current.location_id || ''),
      speaker_id: String(current.speaker_id || ''),
    }
  }
  const lastBeat = [...(history || [])].reverse().find((item) => item?.kind === 'beat')
  if (lastBeat?.eventId || lastBeat?.beat?.id) {
    return {
      event_id: String(lastBeat.eventId || ''),
      beat_id: String(lastBeat.beat?.id || ''),
      location_id: String(lastBeat.beat?.location || ''),
      speaker_id: String(lastBeat.beat?.speaker || ''),
    }
  }
  if (blockedEvent?.id) {
    return {
      event_id: String(blockedEvent.id),
      beat_id: '',
      location_id: '',
      speaker_id: '',
    }
  }
  return {
    event_id: '',
    beat_id: '',
    location_id: '',
    speaker_id: '',
  }
}

/**
 * 编成 POST /chat 的 playtest_context。只含稳定 id、路线和状态。
 *
 * @param {object} input
 * @returns {object} 请求体片段。
 */
export function buildPlaytestRequestPayload({
  status = 'playing',
  phase = 'scene',
  current = {},
  vars = {},
  takenEdges = [],
  revisions = {},
  sceneRevisions = {},
  focusEdgeId = '',
} = {}) {
  const focus = String(focusEdgeId || '').trim()
  return {
    schema_version: 1,
    status: String(status || 'playing'),
    phase: String(phase || 'scene'),
    revisions: { ...(revisions || {}) },
    scene_revisions: { ...(sceneRevisions || {}) },
    current: {
      event_id: String(current?.event_id || ''),
      beat_id: String(current?.beat_id || ''),
      location_id: String(current?.location_id || ''),
      speaker_id: String(current?.speaker_id || ''),
    },
    vars: { ...(vars || {}) },
    taken_edges: (takenEdges || [])
      .filter((edge) => edge?.kind && edge?.edge_id)
      .map((edge) => ({ kind: edge.kind, edge_id: String(edge.edge_id) })),
    focus_edge_id: focus || null,
  }
}

/**
 * 输入框上方的可见标签数据。
 *
 * @param {object} input
 * @param {boolean} [input.stale] 本局已过期。
 * @param {boolean} [input.attachable] 当前可否附带。
 * @param {boolean} [input.idle] 试玩页尚未开局。
 * @param {boolean} [input.pending] 已开局但还不能按节点定位。
 * @param {string} [input.eventTitle] 当前事件标题。
 * @param {string} [input.beatPreview] 当前节点正文摘要。
 * @param {string} [input.focusLabel] 精确引用的选项文案。
 * @returns {{kind: 'none'|'idle'|'pending'|'stale'|'attached', eventTitle?: string, beatPreview?: string, focusLabel?: string}}
 */
export function playtestContextChip({
  stale = false,
  attachable = false,
  idle = false,
  pending = false,
  eventTitle = '',
  beatPreview = '',
  focusLabel = '',
} = {}) {
  if (stale) return { kind: 'stale' }
  if (attachable) {
    return {
      kind: 'attached',
      eventTitle: String(eventTitle || '').trim(),
      beatPreview: String(beatPreview || '').trim(),
      focusLabel: String(focusLabel || '').trim(),
    }
  }
  if (pending) return { kind: 'pending' }
  if (idle) return { kind: 'idle' }
  return { kind: 'none' }
}

/**
 * 把标签编成用户可见短句。
 *
 * @param {{kind: string, eventTitle?: string, beatPreview?: string, focusLabel?: string}|null} chip
 * @param {(key: string, vars?: Record<string, unknown>) => string} t 翻译函数。
 * @returns {string}
 */
export function formatPlaytestChipText(chip, t) {
  if (!chip || chip.kind === 'none') return ''
  if (chip.kind === 'stale') return t('agent.chat.playtestStale')
  if (chip.kind === 'idle') return t('agent.chat.playtestIdle')
  if (chip.kind === 'pending') return t('agent.chat.playtestPending')
  const eventTitle = chip.eventTitle || t('agent.chat.playtestUntitledEvent')
  const preview = chip.beatPreview
    ? t('agent.chat.playtestBeatPreview', { text: truncatePreview(chip.beatPreview) })
    : ''
  const focus = chip.focusLabel
    ? t('agent.chat.playtestFocus', { label: chip.focusLabel })
    : ''
  return t('agent.chat.playtestAttached', { event: eventTitle, preview, focus })
}

/**
 * 截断舞台正文，避免标签过长。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function truncatePreview(text, limit = 24) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}
