/**
 * 概念注册表：只放稳定 id、分类、相关概念和可选工作区目的地。
 * 中英文正文在 help 字典的 help.concept.{id} 下，不在本文件复制。
 */

/** 概念分类顺序：帮助中心侧栏按此排列。 */
export const CONCEPT_CATEGORIES = Object.freeze([
  { id: 'workflow', conceptIds: ['agent', 'agentChangeset', 'draftSave', 'playtest'] },
  { id: 'artifacts', conceptIds: ['materials', 'intent', 'outline', 'worldCard'] },
  { id: 'structure', conceptIds: ['event', 'eventNetwork', 'eventList', 'sceneNetwork', 'beat', 'choice'] },
  { id: 'state', conceptIds: ['stateVariable', 'variableTypes', 'stateWrite', 'unlockCondition'] },
  { id: 'check', conceptIds: ['validation', 'validationStatuses'] },
])

/**
 * @typedef {{
 *   board: 'build' | 'playtest',
 *   tab?: string,
 *   eventsSubtab?: string,
 *   openCurrentScene?: boolean,
 * }} ConceptDestination
 *
 * @typedef {{
 *   id: string,
 *   category: string,
 *   related: string[],
 *   destination: ConceptDestination | null,
 * }} ConceptDefinition
 */

/** @type {ConceptDefinition[]} */
export const CONCEPTS = Object.freeze([
  { id: 'agent', category: 'workflow', related: ['agentChangeset', 'playtest'], destination: null },
  { id: 'agentChangeset', category: 'workflow', related: ['agent', 'draftSave'], destination: null },
  { id: 'materials', category: 'artifacts', related: ['intent', 'agent'], destination: { board: 'build', tab: 'materials' } },
  { id: 'intent', category: 'artifacts', related: ['outline', 'materials'], destination: { board: 'build', tab: 'intent' } },
  { id: 'outline', category: 'artifacts', related: ['intent', 'event'], destination: { board: 'build', tab: 'outline' } },
  { id: 'worldCard', category: 'artifacts', related: ['event', 'playtest'], destination: { board: 'build', tab: 'world' } },
  { id: 'event', category: 'structure', related: ['eventNetwork', 'sceneNetwork'], destination: { board: 'build', tab: 'events', eventsSubtab: 'network' } },
  { id: 'eventNetwork', category: 'structure', related: ['event', 'eventList', 'unlockCondition'], destination: { board: 'build', tab: 'events', eventsSubtab: 'network' } },
  { id: 'eventList', category: 'structure', related: ['event', 'sceneNetwork'], destination: { board: 'build', tab: 'events', eventsSubtab: 'content' } },
  { id: 'sceneNetwork', category: 'structure', related: ['beat', 'choice', 'event'], destination: { board: 'build', tab: 'events', eventsSubtab: 'content', openCurrentScene: true } },
  { id: 'beat', category: 'structure', related: ['sceneNetwork', 'stateWrite', 'choice'], destination: { board: 'build', tab: 'events', eventsSubtab: 'content', openCurrentScene: true } },
  { id: 'choice', category: 'structure', related: ['beat', 'unlockCondition', 'playtest'], destination: { board: 'build', tab: 'events', eventsSubtab: 'content', openCurrentScene: true } },
  { id: 'stateVariable', category: 'state', related: ['variableTypes', 'stateWrite', 'unlockCondition'], destination: { board: 'build', tab: 'events', eventsSubtab: 'variables' } },
  { id: 'variableTypes', category: 'state', related: ['stateVariable', 'stateWrite'], destination: { board: 'build', tab: 'events', eventsSubtab: 'variables' } },
  { id: 'stateWrite', category: 'state', related: ['stateVariable', 'beat'], destination: { board: 'build', tab: 'events', eventsSubtab: 'content', openCurrentScene: true } },
  { id: 'unlockCondition', category: 'state', related: ['stateVariable', 'choice', 'playtest'], destination: { board: 'build', tab: 'events', eventsSubtab: 'network' } },
  { id: 'draftSave', category: 'workflow', related: ['validationStatuses', 'agentChangeset'], destination: null },
  { id: 'validation', category: 'check', related: ['validationStatuses', 'playtest'], destination: { board: 'build', tab: 'events', eventsSubtab: 'validation' } },
  { id: 'validationStatuses', category: 'check', related: ['validation', 'draftSave'], destination: { board: 'build', tab: 'events', eventsSubtab: 'validation' } },
  { id: 'playtest', category: 'workflow', related: ['agent', 'choice', 'validation'], destination: { board: 'playtest' } },
])

const CONCEPT_BY_ID = new Map(CONCEPTS.map((concept) => [concept.id, concept]))

/**
 * 按稳定 id 取概念定义；未知 id 返回 null，调用方应回到总览。
 * @param {string | null | undefined} conceptId
 * @returns {ConceptDefinition | null}
 */
export function getConcept(conceptId) {
  if (!conceptId) return null
  return CONCEPT_BY_ID.get(conceptId) || null
}

/**
 * 概念 id 是否都唯一，供回归断言。
 * @returns {string[]}
 */
export function listConceptIds() {
  return CONCEPTS.map((concept) => concept.id)
}

/**
 * 按当前语言搜索 term / summary / example。
 * @param {string} query
 * @param {(key: string) => string} t
 * @returns {ConceptDefinition[]}
 */
export function searchConcepts(query, t) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return CONCEPTS.slice()
  return CONCEPTS.filter((concept) => {
    const fields = ['term', 'summary', 'example'].map((field) => (
      String(t(`help.concept.${concept.id}.${field}`) || '').toLowerCase()
    ))
    return fields.some((text) => text && !text.startsWith('help.concept.') && text.includes(needle))
  })
}

/**
 * 把概念列表按分类分组，去掉空分类。
 * @param {ConceptDefinition[]} [concepts]
 * @returns {Array<{id: string, concepts: ConceptDefinition[]}>}
 */
export function groupConceptsByCategory(concepts = CONCEPTS) {
  const available = new Set((concepts || []).map((item) => item.id))
  return CONCEPT_CATEGORIES
    .map((category) => ({
      id: category.id,
      concepts: category.conceptIds
        .map((id) => CONCEPT_BY_ID.get(id))
        .filter((item) => item && available.has(item.id)),
    }))
    .filter((group) => group.concepts.length > 0)
}

/**
 * 过滤出仍在注册表里的相关概念。
 * @param {string} conceptId
 * @returns {ConceptDefinition[]}
 */
export function relatedConcepts(conceptId) {
  const concept = getConcept(conceptId)
  if (!concept) return []
  return concept.related.map((id) => CONCEPT_BY_ID.get(id)).filter(Boolean)
}

/**
 * 把注册表目的地落成可执行的工作区切换。
 * 情节/节点在没有当前事件时退到事件列表。
 *
 * @param {string} conceptId
 * @param {{ selectedEventId?: string | null }} [context]
 * @returns {object | null}
 */
export function resolveConceptDestination(conceptId, context = {}) {
  const concept = getConcept(conceptId)
  const destination = concept?.destination
  if (!destination) return null
  const next = {
    board: destination.board,
    tab: destination.tab || null,
    eventsSubtab: destination.eventsSubtab || null,
    openScene: null,
  }
  if (destination.openCurrentScene) {
    const eventId = context.selectedEventId || null
    next.openScene = eventId
    if (!eventId) next.eventsSubtab = 'content'
  }
  return next
}

/**
 * 判断「去当前界面查看」是否可执行。
 *
 * @param {object} input
 * @param {string} input.conceptId
 * @param {boolean} [input.hasProject]
 * @param {boolean} [input.isDemo]
 * @param {boolean} [input.isReview]
 * @param {boolean} [input.hasDirtyDraft]
 * @param {string | null} [input.selectedEventId]
 * @returns {{ allowed: boolean, reason: 'none'|'unavailable'|'demo'|'dirty'|null, destination: object | null }}
 */
export function canNavigateConcept({
  conceptId,
  hasProject = false,
  isDemo = false,
  isReview = false,
  hasDirtyDraft = false,
  selectedEventId = null,
} = {}) {
  const destination = resolveConceptDestination(conceptId, { selectedEventId })
  if (!destination) return { allowed: false, reason: 'none', destination: null }
  if (isReview || !hasProject) return { allowed: false, reason: 'unavailable', destination: null }
  if (isDemo) return { allowed: false, reason: 'demo', destination: null }
  if (hasDirtyDraft) return { allowed: false, reason: 'dirty', destination }
  return { allowed: true, reason: null, destination }
}
