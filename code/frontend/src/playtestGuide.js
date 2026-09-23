/**
 * 快速上手试玩导览：每一步声明目标画面，从干净状态重放到该画面。
 * 只作用于共享只读演示项目，见 DESIGN §5.10。
 */

export const PLAYTEST_GUIDE_TARGETS = ['idle', 'start', 'choices', 'ending']

/**
 * 读取步骤 reveal 上的试玩目标。
 * @param {object|null|undefined} reveal 导览 reveal。
 * @returns {'idle'|'start'|'choices'|'ending'|null}
 */
export function playtestGuideTarget(reveal) {
  const target = reveal?.playtestTarget
  if (target === 'idle' || target === 'start' || target === 'choices' || target === 'ending') {
    return target
  }
  return null
}

/**
 * 该目标是否应自动开局。未开局步骤只显示「开始试玩」。
 * @param {'idle'|'start'|'choices'|'ending'|null|undefined} target
 * @returns {boolean}
 */
export function shouldAutoStartGuidePlaytest(target) {
  return target === 'start' || target === 'choices' || target === 'ending'
}

/**
 * 导览重放时是否应点当前可走选项。
 * 岔路目标在出现多于一条可点选项时停下；结局目标继续走第一条可点选项。
 *
 * @param {'idle'|'start'|'choices'|'ending'|null|undefined} target
 * @param {number} enabledCount 当前可点选项数。
 * @returns {boolean}
 */
export function shouldAdvanceGuidePlaytest(target, enabledCount) {
  if (target === 'choices') return enabledCount === 1
  if (target === 'ending') return enabledCount >= 1
  return false
}

/**
 * 试玩面板挂载键。演示项目带导览会话序号，序号变化时强制重挂载；
 * 普通项目只用项目 id，板块切换不重置。
 *
 * @param {string|null|undefined} projectId 当前项目。
 * @param {object} [options]
 * @param {boolean} [options.isDemo] 是否共享演示项目。
 * @param {number} [options.guideSessionSeq] 演示试玩导览会话序号。
 * @returns {string}
 */
export function playtestPanelKey(projectId, { isDemo = false, guideSessionSeq = 0 } = {}) {
  if (!projectId) return 'none'
  if (!isDemo) return projectId
  return `${projectId}:guide:${guideSessionSeq}`
}

/**
 * 按导览步骤 id 取出试玩目标序列，便于断言前进/后退后画面声明一致。
 *
 * @param {Array<{id: string, reveal?: object}>} steps 导览步骤。
 * @param {string[]} stepIds 走过的步骤 id。
 * @returns {Array<'idle'|'start'|'choices'|'ending'|null>}
 */
export function playtestGuideTargetSequence(steps, stepIds) {
  const byId = new Map((steps || []).map((step) => [step.id, step]))
  return (stepIds || []).map((id) => playtestGuideTarget(byId.get(id)?.reveal))
}
