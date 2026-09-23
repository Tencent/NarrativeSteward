/**
 * 情境提示的检查器焦点与视图键。
 * 细面板按对象类型统一上报；操作结果提示绑定产生时的 viewKey，不跨页面跟随。
 */

/** 允许的检查器类型；关闭时为 null。 */
export const INSPECTOR_KINDS = Object.freeze([
  'world-card',
  'event-node',
  'event-edge',
  'variable',
  'scene-beat',
  'scene-edge',
])

/**
 * @typedef {'world-card'|'event-node'|'event-edge'|'variable'|'scene-beat'|'scene-edge'} InspectorKind
 *
 * @typedef {{
 *   kind: InspectorKind,
 *   id?: string | null,
 *   eventId?: string | null,
 *   category?: string | null,
 * }} InspectorFocus
 */

const INSPECTOR_KIND_SET = new Set(INSPECTOR_KINDS)

/**
 * 把子组件上报规范成单一结构；未知类型视为关闭。
 * @param {object | null | undefined} raw
 * @returns {InspectorFocus | null}
 */
export function normalizeInspectorFocus(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!INSPECTOR_KIND_SET.has(raw.kind)) return null
  return {
    kind: raw.kind,
    id: raw.id || null,
    eventId: raw.eventId || null,
    category: raw.category || null,
  }
}

/**
 * 当前检查器在这个界面路径上是否真的看得见。
 * 隐藏但仍挂载的 EventForm / SceneForm 不得继续贡献旧状态。
 *
 * @param {InspectorFocus | null | undefined} focus
 * @param {object} context
 * @param {string} [context.board]
 * @param {string} [context.activeTab]
 * @param {string} [context.eventsSubtab]
 * @param {'list'|'scene'|null} [context.sceneView]
 * @returns {boolean}
 */
export function isInspectorVisible(focus, context = {}) {
  const normalized = normalizeInspectorFocus(focus)
  if (!normalized) return false
  if (context.board !== 'build') return false
  if (normalized.kind === 'world-card') return context.activeTab === 'world'
  if (normalized.kind === 'event-node' || normalized.kind === 'event-edge') {
    return context.activeTab === 'events' && context.eventsSubtab === 'network'
  }
  if (normalized.kind === 'variable') {
    return context.activeTab === 'events' && context.eventsSubtab === 'variables'
  }
  if (normalized.kind === 'scene-beat' || normalized.kind === 'scene-edge') {
    return context.activeTab === 'events'
      && context.eventsSubtab === 'content'
      && context.sceneView === 'scene'
  }
  return false
}

/**
 * 只在实际可见路径采纳检查器；否则视为关闭。
 * @param {InspectorFocus | null | undefined} focus
 * @param {object} context
 * @returns {InspectorFocus | null}
 */
export function visibleInspectorFocus(focus, context = {}) {
  return isInspectorVisible(focus, context) ? normalizeInspectorFocus(focus) : null
}

/**
 * 从多个上报源里挑出当前真正可见的检查器。
 * 设定页、事件网络、状态变量页和已显示的情节网络互斥。
 *
 * @param {{ world?: InspectorFocus|null, event?: InspectorFocus|null, scene?: InspectorFocus|null }} reports
 * @param {object} context
 * @returns {InspectorFocus | null}
 */
export function resolveVisibleInspector(reports = {}, context = {}) {
  if (context.board !== 'build') return null
  if (context.activeTab === 'world') {
    return visibleInspectorFocus(reports.world, context)
  }
  if (context.activeTab === 'events' && context.eventsSubtab === 'network') {
    return visibleInspectorFocus(reports.event, context)
  }
  if (context.activeTab === 'events' && context.eventsSubtab === 'variables') {
    return visibleInspectorFocus(reports.event, context)
  }
  if (
    context.activeTab === 'events'
    && context.eventsSubtab === 'content'
    && context.sceneView === 'scene'
  ) {
    return visibleInspectorFocus(reports.scene, context)
  }
  return null
}

/**
 * 由板块、一级标签、事件二级标签、情节视图和可见检查器类型组成，供操作提示绑定原始情境。
 * @param {object} context
 * @param {string} [context.board]
 * @param {string} [context.activeTab]
 * @param {string} [context.eventsSubtab]
 * @param {'list'|'scene'|null} [context.sceneView]
 * @param {InspectorFocus | null} [context.inspectorFocus]
 * @returns {string}
 */
export function buildViewKey(context = {}) {
  const board = context.board || ''
  const tab = board === 'build' ? (context.activeTab || '') : ''
  const subtab = tab === 'events' ? (context.eventsSubtab || '') : ''
  const scene = tab === 'events' && subtab === 'content'
    ? (context.sceneView || 'list')
    : ''
  const inspector = isInspectorVisible(context.inspectorFocus, context)
    ? context.inspectorFocus.kind
    : ''
  return [board, tab, subtab, scene, inspector].join('/')
}

/**
 * 页面级视图键：不含检查器。操作结果提示按页面绑定，打开卡片或节点不会改掉绑定。
 * @param {object} context
 * @returns {string}
 */
export function buildPageViewKey(context = {}) {
  return buildViewKey({
    board: context.board,
    activeTab: context.activeTab,
    eventsSubtab: context.eventsSubtab,
    sceneView: context.sceneView,
    inspectorFocus: null,
  })
}

/**
 * 收集历史消息里已经出现过的修改摘要 id，供项目加载时建立基线。
 * @param {Array<{ changeset?: { id?: string, counts?: { total?: number } } }>} messages
 * @returns {Set<string>}
 */
export function collectChangesetIds(messages = []) {
  const ids = new Set()
  for (const message of messages) {
    const id = message?.changeset?.id
    if (id && message.changeset?.counts?.total) ids.add(id)
  }
  return ids
}
