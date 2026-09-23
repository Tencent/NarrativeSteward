/**
 * 试玩内容版本键与强制重开判定。
 *
 * 运行：node tests/playtest_session_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLAYTEST_SESSION_IDLE,
  PLAYTEST_SESSION_RESTART_REQUIRED,
  PLAYTEST_SESSION_SAME,
  playtestContentVersionKey,
  playtestSessionDecision,
  playtestSessionState,
} from '../src/playtestSessionPolicy.js'
import { playtestPanelKey } from '../src/playtestGuide.js'

const here = dirname(fileURLToPath(import.meta.url))

const firstOrder = playtestContentVersionKey({
  revisions: { world: 2, events: 3, intent: 1 },
  scene_revisions: { 'ev-b': 4, 'ev-a': 1 },
})
const shuffledOrder = playtestContentVersionKey({
  revisions: { intent: 1, events: 3, world: 2 },
  scene_revisions: { 'ev-a': 1, 'ev-b': 4 },
})
assert.equal(firstOrder, shuffledOrder, '版本键不依赖对象键插入顺序')
assert.equal(
  firstOrder,
  'fragments=events:3,intent:1,world:2|scenes=ev-a:1,ev-b:4',
  '片段与情节 revision 分别按字母排序',
)
assert.equal(
  playtestContentVersionKey(null),
  'fragments=|scenes=',
  '缺项目时版本键为空映射，不抛错',
)

const opened = {
  started: true,
  startedVersionKey: firstOrder,
  currentVersionKey: firstOrder,
}
assert.equal(playtestSessionState(opened), PLAYTEST_SESSION_SAME, '同版本可继续原局')
assert.equal(
  playtestSessionDecision({ ...opened, agentTurnActive: false }).mustRestart,
  false,
  '只读或未改版本不要求重开',
)

assert.equal(
  playtestSessionState({ started: false, startedVersionKey: '', currentVersionKey: firstOrder }),
  PLAYTEST_SESSION_IDLE,
  '未开局不算过时',
)

const eventsBumped = playtestContentVersionKey({
  revisions: { world: 2, events: 4, intent: 1 },
  scene_revisions: { 'ev-b': 4, 'ev-a': 1 },
})
assert.equal(
  playtestSessionState({ ...opened, currentVersionKey: eventsBumped }),
  PLAYTEST_SESSION_RESTART_REQUIRED,
  '任一普通片段 revision 变化都要求重开',
)

const sceneBumped = playtestContentVersionKey({
  revisions: { world: 2, events: 3, intent: 1 },
  scene_revisions: { 'ev-b': 5, 'ev-a': 1 },
})
assert.equal(
  playtestSessionState({ ...opened, currentVersionKey: sceneBumped }),
  PLAYTEST_SESSION_RESTART_REQUIRED,
  '任一情节 revision 变化都要求重开',
)

const sceneAdded = playtestContentVersionKey({
  revisions: { world: 2, events: 3, intent: 1 },
  scene_revisions: { 'ev-b': 4, 'ev-a': 1, 'ev-c': 1 },
})
assert.equal(
  playtestSessionState({ ...opened, currentVersionKey: sceneAdded }),
  PLAYTEST_SESSION_RESTART_REQUIRED,
  '新增情节 revision 也要求重开',
)

assert.equal(
  playtestSessionState({ ...opened, currentVersionKey: firstOrder }),
  PLAYTEST_SESSION_SAME,
  '停止或失败回滚到原版本后不要求重开',
)

const duringWrite = playtestSessionDecision({
  started: true,
  startedVersionKey: firstOrder,
  currentVersionKey: eventsBumped,
  agentTurnActive: true,
})
assert.equal(duringWrite.interactionLocked, true, '执行或对账期间保持交互锁')
assert.equal(duringWrite.mustRestart, false, '对账完成前不宣布本局过时，避免回滚后误报')

const afterCommit = playtestSessionDecision({
  started: true,
  startedVersionKey: firstOrder,
  currentVersionKey: eventsBumped,
  agentTurnActive: false,
})
assert.equal(afterCommit.mustRestart, true, '终态对账后版本仍变则必须重开')
assert.equal(afterCommit.interactionLocked, false)

const afterRollback = playtestSessionDecision({
  started: true,
  startedVersionKey: firstOrder,
  currentVersionKey: firstOrder,
  agentTurnActive: false,
})
assert.equal(afterRollback.mustRestart, false, '回滚恢复原版本后可继续原局')

const appSource = readFileSync(join(here, '../src/App.jsx'), 'utf8')
const panelSource = readFileSync(join(here, '../src/components/PlaytestPanel.jsx'), 'utf8')
assert.match(appSource, /playtestContentVersionKey\(project\)/, 'App 用项目 meta 生成版本键')
assert.match(appSource, /contentVersionKey=\{playtestContentKey\}/, '把当前版本键交给试玩面板')
assert.match(appSource, /agentTurnActive=\{agentTurnActive\}/, '把回合锁交给试玩面板')
assert.equal(
  playtestPanelKey('proj-live', { isDemo: false, guideSessionSeq: 4 }),
  'proj-live',
  '普通项目板块切换不因导览序号重置试玩',
)
assert.match(appSource, /playtestPanelKey\(selectedId/)
assert.match(
  appSource,
  /<PlaytestPanel\s+key=\{playtestPanelKey/,
  '演示试玩 key 必须带导览会话，不能只用项目 id',
)
assert.doesNotMatch(
  appSource,
  /if \(disabled \|\| agentTurnActive\)/,
  'Agent 执行不得走整页不可用空状态',
)
assert.match(panelSource, /playtestSessionDecision/, '试玩面板用版本策略判定暂停/重开')
assert.match(panelSource, /playtest\.contentUpdated/, '版本变化后提示必须重开')
assert.match(panelSource, /disabled=\{!pt\.canUndo \|\| actionsLocked\}/, '强制重开时回退不可用')
assert.match(panelSource, /disabled=\{c\.disabled \|\| actionsLocked\}/, '强制重开或执行中选项不可用')
assert.match(panelSource, /disabled=\{interactionLocked \|\| pt\.isAdvancing\}/, '执行中不可重开，版本过时仍可重开')
assert.doesNotMatch(
  panelSource,
  /if \(disabled \|\| agentTurnActive\)/,
  'Agent 执行不再用整页空状态替换舞台',
)

console.log('playtest_session_check: pass')
