/**
 * 试玩局与项目正式内容版本的对照规则。
 * 见 DESIGN §5.6：开局记下 revisions + scene_revisions，之后只看正式版本是否变化。
 * 不读 SSE 摘要，也不把可回滚预览当成过期。
 */

/** 尚未开局。 */
export const PLAYTEST_SESSION_IDLE = 'idle'

/** 已开局，且仍对应开局时的正式内容版本。 */
export const PLAYTEST_SESSION_SAME = 'same'

/** 已开局，但正式内容版本已变，只能重新开始。 */
export const PLAYTEST_SESSION_RESTART_REQUIRED = 'restart_required'

/**
 * 把 revision 映射编成稳定字符串：键按字母排序，避免对象插入顺序影响比较。
 *
 * @param {Record<string, number>|null|undefined} map 片段或情节 revision。
 * @returns {string} 如 `events:3,world:1`；空映射为 `''`。
 */
function encodeRevisionMap(map) {
  return Object.keys(map || {})
    .sort()
    .map((key) => `${key}:${Number(map[key]) || 0}`)
    .join(',')
}

/**
 * 从项目 meta 生成稳定的正式内容版本键。
 *
 * @param {{revisions?: Record<string, number>, scene_revisions?: Record<string, number>}|null|undefined} project
 *   GET /projects/{id} 返回的公开 meta；缺字段视为空映射。
 * @returns {string} 形如 `fragments=events:2|scenes=ev-1:1`。
 */
export function playtestContentVersionKey(project) {
  const fragments = encodeRevisionMap(project?.revisions)
  const scenes = encodeRevisionMap(project?.scene_revisions)
  return `fragments=${fragments}|scenes=${scenes}`
}

/**
 * 仅比较开局版本与当前版本，不看 Agent 是否仍在执行。
 *
 * @param {object} [input]
 * @param {boolean} [input.started] 是否已经开过局（含加载中、结局、死路）。
 * @param {string} [input.startedVersionKey] 开局时记下的版本键。
 * @param {string} [input.currentVersionKey] 当前项目 meta 的版本键。
 * @returns {'idle'|'same'|'restart_required'}
 */
export function playtestSessionState({
  started = false,
  startedVersionKey = '',
  currentVersionKey = '',
} = {}) {
  if (!started) return PLAYTEST_SESSION_IDLE
  if (!startedVersionKey || startedVersionKey === currentVersionKey) {
    return PLAYTEST_SESSION_SAME
  }
  return PLAYTEST_SESSION_RESTART_REQUIRED
}

/**
 * 综合 Agent 执行锁与版本比较，决定这一帧能否继续原局。
 *
 * Agent 仍在执行或终态尚未对账完时，即使预览已经改过文件，也不宣布本局过时；
 * 等锁解除后再用最终 revision 判断，避免回滚后误报、或先解锁再立刻要求重开。
 *
 * @param {object} [input]
 * @param {boolean} [input.started] 是否已经开过局。
 * @param {string} [input.startedVersionKey] 开局时记下的版本键。
 * @param {string} [input.currentVersionKey] 当前项目 meta 的版本键。
 * @param {boolean} [input.agentTurnActive] 回合运行中、正在停止，或终态对账未完成。
 * @returns {{
 *   sessionState: 'idle'|'same'|'restart_required',
 *   interactionLocked: boolean,
 *   mustRestart: boolean,
 * }}
 */
export function playtestSessionDecision({
  started = false,
  startedVersionKey = '',
  currentVersionKey = '',
  agentTurnActive = false,
} = {}) {
  const sessionState = playtestSessionState({
    started,
    startedVersionKey,
    currentVersionKey,
  })
  const interactionLocked = Boolean(agentTurnActive)
  return {
    sessionState,
    interactionLocked,
    mustRestart: !interactionLocked && sessionState === PLAYTEST_SESSION_RESTART_REQUIRED,
  }
}
