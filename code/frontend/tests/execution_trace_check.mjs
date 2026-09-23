/**
 * 执行树去重、展开规则，以及过程文本与最终答复分流。
 *
 * 运行：node tests/execution_trace_check.mjs
 */

import assert from 'node:assert/strict'

import {
  applyStatusNotes,
  applyTraceEvent,
  hasBlockingDraft,
  isDuplicateTraceEvent,
  isStepExpanded,
  shouldDisplayStatusNote,
  shouldRevealStepPayload,
  waitingForModelMessage,
} from '../src/hooks/useExecutionTrace.js'

const seen = new Set()
assert.equal(isDuplicateTraceEvent(seen, { turn_id: 't1', sequence: 1 }), false)
assert.equal(isDuplicateTraceEvent(seen, { turn_id: 't1', sequence: 1 }), true)
assert.equal(isDuplicateTraceEvent(seen, { turn_id: 't1', sequence: 2 }), false)
assert.equal(isDuplicateTraceEvent(seen, { sequence: 1 }), false, '缺少 turn_id 时不过度去重')

const active = { stepId: 'root', done: false }
const doneOk = { stepId: 'write', parentStepId: 'root', done: true }
const failed = { stepId: 'bad', parentStepId: 'root', done: true, error: '写入失败' }
const doneRoot = { stepId: 'done-root', done: true }
const steps = [active, doneOk, failed, doneRoot]
assert.equal(isStepExpanded(active, steps), true, '活动步骤自动展开')
assert.equal(isStepExpanded(failed, steps), true, '失败步骤保持展开')
assert.equal(isStepExpanded(doneOk, steps), false, '成功步骤自动收起')
assert.equal(isStepExpanded(doneRoot, steps), false, '无失败子步骤的完成根步骤收起')
assert.equal(
  isStepExpanded({ ...active, done: true }, [ { ...active, done: true }, failed ]),
  true,
  '祖先在子步骤失败时保持展开',
)
assert.equal(
  isStepExpanded(doneOk, steps, { write: true }),
  true,
  '用户手动展开优先于自动收起',
)

assert.equal(
  shouldRevealStepPayload({ done: false, input: { path: '/project/intent.md' } }, true),
  true,
  '活动步骤有调用参数时直接摊开',
)
assert.equal(
  shouldRevealStepPayload({ done: false, agentText: '正在写' }, true),
  true,
  '活动步骤有过程文本时直接摊开',
)
assert.equal(
  shouldRevealStepPayload({ done: true, input: { path: '/project/intent.md' } }, false),
  false,
  '收起的完成步骤不露出载荷',
)
assert.equal(
  shouldRevealStepPayload({ done: true, output: 'ok' }, true),
  true,
  '手动展开后直接显示结果',
)

const parentRunning = { stepId: 'task', done: false, input: { description: '设计事件图' } }
const earlierChild = { stepId: 'write-early', parentStepId: 'task', done: true, output: 'ok' }
const lastChild = { stepId: 'write-last', parentStepId: 'task', done: true, output: 'events.json' }
const runningTree = [parentRunning, earlierChild, lastChild]
assert.equal(isStepExpanded(parentRunning, runningTree), true, '父任务进行中保持展开')
assert.equal(isStepExpanded(earlierChild, runningTree), false, '较早完成的子步骤仍收起')
assert.equal(isStepExpanded(lastChild, runningTree), true, '父任务进行中时最近子步骤保持可见')
assert.equal(
  waitingForModelMessage(parentRunning, runningTree),
  '子步骤已完成，正在等待模型决定下一步',
)
assert.equal(
  shouldRevealStepPayload(parentRunning, true, runningTree),
  true,
  '等待模型时即使没有新正文也摊开提示',
)
assert.equal(waitingForModelMessage(lastChild, runningTree), null)

let message = { text: '', steps: [], streaming: true }
message = applyTraceEvent(message, 'tool_start', {
  step_id: 'root',
  tool: 'main-agent',
  label: '正在执行本轮任务',
})
message = applyTraceEvent(message, 'agent_text', {
  step_id: 'root',
  text: '正在阅读资料',
})
message = applyTraceEvent(message, 'tool_start', {
  step_id: 'write',
  parent_step_id: 'root',
  tool: 'write_file',
  label: '正在撰写内容',
  input: { path: '/project/intent.md' },
})
assert.equal(message.text, '', '过程文本不进入最终聊天气泡')
assert.equal(message.steps[0].agentText, '正在阅读资料')
assert.equal(message.steps[1].parentStepId, 'root')

message = applyTraceEvent(message, 'turn_completed', {
  text: '已经记下创作意图。',
  partial: true,
  budget_closed: true,
  remaining_parts: ['世界设定'],
})
assert.equal(message.text, '已经记下创作意图。', '最终答复在回合完成后进入气泡')
assert.equal(message.partial, true)
assert.equal(message.budgetClosed, true)
assert.deepEqual(message.remainingParts, ['世界设定'])
assert.ok(message.steps.every((step) => step.done), '完成后步骤全部标记完成')

assert.equal(hasBlockingDraft({ intent: true }), true)
assert.equal(hasBlockingDraft({ intent: false, outline: false }), false)

assert.equal(shouldDisplayStatusNote({ audience: 'agent' }), false, 'Agent 专用 status 不进对话浮条')
assert.equal(shouldDisplayStatusNote({ audience: 'user' }), true)
assert.equal(shouldDisplayStatusNote({ audience: 'both' }), true)
assert.equal(shouldDisplayStatusNote({ text: '旧事件没有 audience' }), true, '缺省按 user 兼容旧事件')

const hidden = applyTraceEvent({ statusNotes: [] }, 'status', {
  audience: 'agent',
  text: '[系统状态] 请调用 read_latest_state_validation',
})
assert.deepEqual(hidden.statusNotes, [], 'agent-only status 不写入 statusNotes')

let notes = applyStatusNotes([], {
  text: '本次中间结果未通过一致性检查，当前仍显示上一有效版本。',
  phase: 'checkpoint_invalid',
  code: 'checkpoint_invalid',
  audience: 'user',
})
notes = applyStatusNotes(notes, {
  text: '本次中间结果未通过一致性检查，当前仍显示上一有效版本。',
  phase: 'checkpoint_invalid',
  code: 'checkpoint_invalid',
  audience: 'user',
})
assert.equal(notes.length, 1, '同一回合重复的检查点失败只保留一条')
assert.match(notes[0].text, /上一有效版本/, '用户看到中性预览保留说明')
assert.equal(notes[0].code, 'checkpoint_invalid')

const legacy = applyTraceEvent({ statusNotes: [] }, 'status', {
  text: '本轮内容已更新，但修改摘要生成失败；请先人工检查后再继续。',
})
assert.equal(legacy.statusNotes.length, 1, '旧 status 事件仍显示')
assert.match(legacy.statusNotes[0].text, /修改摘要生成失败/)

console.log('execution_trace_check: pass')
