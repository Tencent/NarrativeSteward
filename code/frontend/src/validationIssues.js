import { tZh } from './i18n/translate.js'

/**
 * 递归规范化 JSON 值，保证对象键顺序不同但内容相同的问题可以生成相同分组键。
 *
 * @param {unknown} value 待规范化的 JSON 值。
 * @returns {unknown} 键已排序的等价值。
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

/**
 * 为一个非连锁问题生成稳定分组键。
 * 条件失败的 message 可能包含具体状态说明，因此优先使用结构化定位、条件和状态去重。
 *
 * @param {Record<string, unknown>} issue 检测器返回的原始问题。
 * @returns {string} 稳定分组键。
 */
function rootIssueKey(issue) {
  const locators = {
    event_id: issue.event_id,
    beat_id: issue.beat_id,
    edge_id: issue.edge_id,
    node_id: issue.node_id,
    position: issue.position,
    source_position: issue.source_position,
    target_position: issue.target_position,
    condition: issue.condition,
    state: issue.state,
  }
  const hasStructuredLocation = Object.values(locators).some((value) => value !== null && value !== undefined)
  return JSON.stringify(canonicalize({
    kind: issue.kind,
    layer: issue.layer,
    ...locators,
    message: hasStructuredLocation ? undefined : issue.message,
  }))
}

/**
 * 为一个由上游不可达引起的问题返回聚合位置与受影响 id。
 *
 * @param {Record<string, unknown>} issue 检测器返回的问题。
 * @returns {{key: string, affectedId: string|null}} 聚合键与受影响对象 id。
 */
function cascadeLocation(issue, t = tZh) {
  const eventId = issue.event_id || t('common.unknownEvent')
  const affectedId = issue.beat_id || issue.edge_id || issue.event_id || null
  return {
    key: `${issue.kind}:${eventId}`,
    affectedId,
  }
}

/**
 * 生成人读的连锁影响摘要。
 *
 * @param {Record<string, any>} group 同类连锁问题聚合。
 * @returns {string} 面向创作者的摘要。
 */
function cascadeMessage(group, t = tZh) {
  const ids = [...group.affectedIds].sort().join('、')
  if (group.kind === 'beat_unreachable') {
    return t('validation.issue.cascadeBeats', { event: group.event_id, count: group.affectedIds.size, ids })
  }
  if (group.kind === 'event_edge_never_enabled' || group.kind === 'scene_edge_never_enabled') {
    return t('validation.issue.cascadeEdges', { event: group.event_id, count: group.affectedIds.size, ids })
  }
  if (group.kind === 'event_unreachable') {
    return t('validation.issue.cascadeEvents', { count: group.affectedIds.size, ids })
  }
  return t('validation.issue.cascadeOther', { count: group.occurrences })
}

/**
 * 把正式报告的原始 issues 转换为面向创作者的展示分组。
 * 原始报告不被修改：相同根因合并计数，未到达项作为连锁影响按事件集中展示。
 *
 * @param {Array<Record<string, unknown>>} rawIssues 检测器原始问题数组。
 * @returns {{
 *   primary: Array<Record<string, unknown>>,
 *   cascades: Array<Record<string, unknown>>,
 *   rawCount: number
 * }} 聚合后的主要问题、连锁影响和原始记录数。
 */
export function groupValidationIssues(rawIssues = [], t = tZh) {
  const issues = Array.isArray(rawIssues) ? rawIssues : []
  const primaryByKey = new Map()
  const cascadeByKey = new Map()

  for (const issue of issues) {
    const count = Number.isFinite(issue.occurrences) ? issue.occurrences : 1
    if (issue.cascade === true) {
      const { key, affectedId } = cascadeLocation(issue, t)
      const existing = cascadeByKey.get(key)
      if (existing) {
        existing.occurrences += count
        if (affectedId) existing.affectedIds.add(affectedId)
      } else {
        cascadeByKey.set(key, {
          kind: issue.kind,
          event_id: issue.event_id || t('common.unknownEvent'),
          occurrences: count,
          affectedIds: new Set(affectedId ? [affectedId] : []),
        })
      }
      continue
    }

    const key = rootIssueKey(issue)
    const existing = primaryByKey.get(key)
    if (existing) {
      existing.occurrences += count
    } else {
      primaryByKey.set(key, { ...issue, occurrences: count })
    }
  }

  const cascades = [...cascadeByKey.values()].map((group) => {
    const affectedIds = [...group.affectedIds].sort()
    const firstAffectedId = affectedIds[0] || null
    return {
      kind: group.kind,
      event_id: group.event_id,
      beat_id: group.kind === 'beat_unreachable' ? firstAffectedId : undefined,
      edge_id: group.kind.endsWith('edge_never_enabled') ? firstAffectedId : undefined,
      affected_ids: affectedIds,
      occurrences: group.occurrences,
      message: cascadeMessage(group, t),
    }
  })

  return {
    primary: [...primaryByKey.values()],
    cascades,
    rawCount: issues.length,
  }
}
