/**
 * Agent 可观察执行轨迹：把 SSE 过程事件应用到助手回合，并计算步骤展开状态。
 * 过程文本写入步骤卡片，最终答复只在回合完成时进入聊天气泡。
 */

import { tZh } from '../i18n/translate.js'

export const MAIN_AGENT_NAME = 'main-agent'

/** 同时兼容 SSE camelCase 与历史 snake_case。 */
export const getStepId = (step) => step?.stepId || step?.step_id || null
export const getParentStepId = (step) => step?.parentStepId || step?.parent_step_id || null

/**
 * 判断这条事件是否已经按 turn_id + sequence 处理过。
 * @param {Set<string>} seen 已处理键。
 * @param {object} payload SSE 载荷。
 * @returns {boolean} 重复则为 true。
 */
export function isDuplicateTraceEvent(seen, payload) {
  const turnId = payload?.turn_id
  const sequence = payload?.sequence
  if (turnId == null || sequence == null) return false
  const key = `${turnId}:${sequence}`
  if (seen.has(key)) return true
  seen.add(key)
  return false
}

/**
 * status 是否应显示给用户。缺省 audience 按 user 兼容旧事件。
 * @param {object} [payload]
 * @returns {boolean}
 */
export function shouldDisplayStatusNote(payload) {
  const audience = payload?.audience || 'user'
  return audience === 'user' || audience === 'both'
}

/**
 * 状态提示的稳定去重键：优先 code，其次 phase。
 * @param {object} [payload]
 * @returns {string|null}
 */
export function statusNoteCode(payload) {
  return payload?.code || payload?.phase || null
}

/**
 * 把一条用户可见 status 合并进当前回合提示。同一 code 的检查点失败只保留一条。
 * @param {Array<{text?: string, level?: string, code?: string|null, at?: number}>} notes
 * @param {object} payload
 * @returns {Array}
 */
export function applyStatusNotes(notes, payload) {
  if (!shouldDisplayStatusNote(payload)) return notes || []
  const next = {
    text: payload.message || payload.text || '',
    level: payload.level || payload.phase || 'info',
    code: statusNoteCode(payload),
    at: Date.now(),
  }
  const existing = [...(notes || [])]
  if (next.code === 'checkpoint_invalid') {
    const index = existing.findIndex((note) => note.code === 'checkpoint_invalid' || note.level === 'checkpoint_invalid')
    if (index >= 0) {
      const copy = [...existing]
      copy[index] = next
      return copy
    }
  }
  existing.push(next)
  return existing
}

function findStepIndex(steps, stepId) {
  if (!stepId) return -1
  return steps.findIndex((step) => getStepId(step) === stepId)
}

function upsertStep(steps, nextStep) {
  const index = findStepIndex(steps, getStepId(nextStep))
  if (index < 0) return [...steps, nextStep]
  const copy = [...steps]
  copy[index] = { ...copy[index], ...nextStep }
  return copy
}

/**
 * 把一条过程事件应用到当前助手消息。
 * @param {object} message 当前助手回合。
 * @param {string} type SSE 事件名。
 * @param {object} payload 事件载荷。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数；缺省中文。
 * @returns {object} 更新后的消息。
 */
export function applyTraceEvent(message, type, payload, t = tZh) {
  const steps = message.steps || []
  if (type === 'agent_text') {
    const stepId = payload.step_id || payload.parent_step_id
    const index = findStepIndex(steps, stepId)
    if (index < 0) {
      return {
        ...message,
        steps: [
          ...steps,
          {
            stepId,
            parentStepId: payload.parent_step_id || null,
            tool: payload.agent || MAIN_AGENT_NAME,
            agent: payload.agent,
            label: t('agent.chat.executing'),
            done: false,
            agentText: payload.text || '',
          },
        ],
      }
    }
    const copy = [...steps]
    copy[index] = {
      ...copy[index],
      agentText: `${copy[index].agentText || ''}${payload.text || ''}`,
    }
    return { ...message, steps: copy }
  }
  if (type === 'tool_start') {
    const stepId = payload.step_id
    if (stepId && findStepIndex(steps, stepId) >= 0) return message
    return {
      ...message,
      steps: [
        ...steps,
        {
          stepId: stepId || null,
          parentStepId: payload.parent_step_id || null,
          tool: payload.tool,
          agent: payload.agent,
          subagent: payload.subagent,
          label: payload.label,
          doneLabel: payload.done_label || null,
          done: false,
          startedAt: Date.now(),
          input: payload.input ?? null,
          agentText: '',
        },
      ],
    }
  }
  if (type === 'tool_end') {
    const copy = [...steps]
    for (let i = copy.length - 1; i >= 0; i -= 1) {
      const currentId = getStepId(copy[i])
      const idMatches = payload.step_id && currentId === payload.step_id
      const legacyMatches = !payload.step_id && !copy[i].done && copy[i].tool === payload.tool
      if (idMatches || legacyMatches) {
        copy[i] = {
          ...copy[i],
          done: true,
          output: payload.output ?? copy[i].output ?? null,
          error: payload.error || null,
          durationMs: payload.duration_ms,
        }
        break
      }
    }
    return { ...message, steps: copy }
  }
  if (type === 'budget_status' || type === 'status') {
    if (!shouldDisplayStatusNote(payload)) return message
    return { ...message, statusNotes: applyStatusNotes(message.statusNotes, payload) }
  }
  if (type === 'turn_completed') {
    return {
      ...message,
      text: payload.text || message.text || '',
      steps: steps.map((step) => ({ ...step, done: true })),
      changeset: payload.changeset || message.changeset || null,
      streaming: false,
      partial: Boolean(payload.partial),
      budgetClosed: Boolean(payload.budget_closed),
      completedParts: payload.completed_parts || [],
      remainingParts: payload.remaining_parts || [],
    }
  }
  if (type === 'turn_stopped') {
    const closed = steps.map((step) => ({
      ...step,
      done: true,
      outcome: 'rolled_back',
    }))
    return {
      ...message,
      text: payload.text || t('agent.chat.stoppedNoKeep'),
      steps: closed,
      changeset: null,
      streaming: false,
      stopped: true,
      rolledBack: payload.rolled_back !== false,
      rollbackFailed: Boolean(payload.rollback_failed),
      partial: false,
      budgetClosed: false,
      remainingParts: [],
    }
  }
  return message
}

/**
 * 计算某一步是否应展开：失败保持展开，进行中及其祖先展开，
 * 进行中父任务的最近子步骤保持可见，用户手动选择优先。
 * @param {object} step 当前步骤。
 * @param {Array<object>} steps 全部步骤。
 * @param {Record<string, boolean>} userExpanded 用户手动覆盖。
 * @returns {boolean}
 */
export function isStepExpanded(step, steps, userExpanded = {}) {
  const id = getStepId(step)
  if (id && Object.prototype.hasOwnProperty.call(userExpanded, id)) {
    return userExpanded[id]
  }
  if (step.error) return true
  if (step.outcome === 'rolled_back') return true
  if (!step.done) return true
  if (isLatestChildOfRunningParent(step, steps)) return true
  return steps.some((child) => (
    getParentStepId(child) === id && isStepExpanded(child, steps, userExpanded)
  ))
}

/**
 * 父任务仍在运行时，保持最近一个子步骤可见，避免只剩“总任务进行中”却看不到刚完成的读写。
 * @param {object} step 当前步骤。
 * @param {Array<object>} steps 全部步骤。
 * @returns {boolean}
 */
export function isLatestChildOfRunningParent(step, steps) {
  const parentId = getParentStepId(step)
  if (!parentId) return false
  const parent = (steps || []).find((item) => getStepId(item) === parentId)
  if (!parent || parent.done) return false
  const siblings = (steps || []).filter((item) => getParentStepId(item) === parentId)
  const latest = siblings[siblings.length - 1]
  return Boolean(latest && getStepId(latest) === getStepId(step))
}

/**
 * 子步骤都结束后父任务仍在运行：模型还在决定下一步，需要明确说出来。
 * @param {object} step 当前步骤。
 * @param {Array<object>} steps 全部步骤。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数；缺省中文。
 * @returns {string|null}
 */
export function waitingForModelMessage(step, steps, t = tZh) {
  if (!step || step.done) return null
  const id = getStepId(step)
  const children = (steps || []).filter((item) => getParentStepId(item) === id)
  if (children.length === 0 || children.some((item) => !item.done)) return null
  return t('agent.chat.waitingModel')
}

/**
 * 展开的步骤是否应直接露出过程文本或工具载荷。
 * 活动步骤即使还没有正文，只要已有调用参数也要摊开，避免再点一次折叠。
 * @param {object} step 当前步骤。
 * @param {boolean} expanded 该步是否处于展开态。
 * @param {Array<object>} [steps] 全部步骤，用于判断父任务是否在等待模型。
 * @returns {boolean}
 */
export function shouldRevealStepPayload(step, expanded, steps = []) {
  if (!expanded || !step) return false
  if (step.agentText || step.input != null || step.output != null || step.error) return true
  return Boolean(waitingForModelMessage(step, steps))
}

/**
 * 存在未保存草稿时不能启动 Agent。
 * @param {Record<string, boolean>} dirtyMap 各面板 dirty 标记。
 * @returns {boolean}
 */
export function hasBlockingDraft(dirtyMap) {
  return Object.values(dirtyMap || {}).some(Boolean)
}

export { upsertStep }
