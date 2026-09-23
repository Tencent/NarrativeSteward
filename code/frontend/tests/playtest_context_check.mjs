/**
 * 试玩情景快照、附带条件与可见标签。
 *
 * 运行：node tests/playtest_context_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tZh } from '../src/i18n/translate.js'
import {
  buildPlaytestRequestPayload,
  formatPlaytestChipText,
  inferPlaytestPhase,
  playtestCitableEdgeIds,
  playtestContextChip,
  recordTakenEdge,
  resolvePlaytestCurrent,
  shouldAttachPlaytestContext,
  truncatePreview,
} from '../src/playtestContext.js'

const here = dirname(fileURLToPath(import.meta.url))

let route = []
route = recordTakenEdge(route, 'scene', 'se-help')
route = recordTakenEdge(route, 'event', 'ee-gate')
route = recordTakenEdge(route, 'scene', '')
route = recordTakenEdge(route, 'event', null)
assert.deepEqual(
  route,
  [
    { kind: 'scene', edge_id: 'se-help' },
    { kind: 'event', edge_id: 'ee-gate' },
  ],
  '只记录真实经过的情节边和事件边',
)

assert.equal(inferPlaytestPhase('playing', [{ kind: 'beat' }]), 'scene')
assert.equal(inferPlaytestPhase('playing', [{ kind: 'event_boundary' }]), 'event_boundary')
assert.equal(inferPlaytestPhase('playing', [{ kind: 'event' }]), 'event_transition')
assert.equal(inferPlaytestPhase('ending', []), 'ending')

assert.deepEqual(
  playtestCitableEdgeIds([
    { kind: 'event_boundary' },
    { kind: 'beat', edge: { id: 'se-1' } },
    { kind: 'beat', disabled: true, edge: { id: 'se-2' } },
  ]),
  ['se-1', 'se-2'],
  '锁定选项也可引用；事件边界按钮不可引用',
)

assert.equal(
  shouldAttachPlaytestContext({
    board: 'playtest',
    mustRestart: false,
    status: 'playing',
    eventId: 'ev-1',
  }),
  true,
  '试玩页且本局有效时附带情景',
)
assert.equal(
  shouldAttachPlaytestContext({
    board: 'build',
    mustRestart: false,
    status: 'playing',
    eventId: 'ev-1',
  }),
  false,
  '构建页即使试玩仍挂载也不附带',
)
assert.equal(
  shouldAttachPlaytestContext({
    board: 'playtest',
    mustRestart: true,
    status: 'playing',
    eventId: 'ev-1',
  }),
  false,
  '版本过期不附带',
)
assert.equal(
  shouldAttachPlaytestContext({
    board: 'playtest',
    status: 'idle',
    eventId: '',
  }),
  false,
  '未开局不附带',
)

const payload = buildPlaytestRequestPayload({
  status: 'playing',
  phase: 'scene',
  current: { event_id: 'ev-1', beat_id: 'b2', location_id: 'loc', speaker_id: 'char' },
  vars: { trust: 20 },
  takenEdges: route,
  revisions: { events: 2 },
  sceneRevisions: { 'ev-1': 1 },
  focusEdgeId: 'se-2',
})
assert.equal(payload.schema_version, 1)
assert.equal(payload.focus_edge_id, 'se-2')
assert.deepEqual(payload.taken_edges, route)
assert.equal(payload.current.event_id, 'ev-1')

const attached = playtestContextChip({
  attachable: true,
  eventTitle: '城门',
  beatPreview: '我从没见过你。这是一句很长的对白，需要截断。',
  focusLabel: '出示通行证',
})
const attachedText = formatPlaytestChipText(attached, tZh)
assert.match(attachedText, /已附带/, '可见标签说明已附带情景')
assert.match(attachedText, /城门/)
assert.match(attachedText, /出示通行证/)
assert.equal(truncatePreview('短'), '短')

const staleText = formatPlaytestChipText(playtestContextChip({ stale: true }), tZh)
assert.match(staleText, /重新开始/, '过期时提示必须重开')
assert.equal(formatPlaytestChipText(playtestContextChip({ attachable: false }), tZh), '')
assert.match(
  formatPlaytestChipText(playtestContextChip({ idle: true }), tZh),
  /开始试玩/,
  '试玩页未开局也显示提示',
)
assert.match(
  formatPlaytestChipText(playtestContextChip({ pending: true }), tZh),
  /正在定位/,
  '已开局但尚未定位时显示等待',
)
assert.deepEqual(
  resolvePlaytestCurrent(null, [{ kind: 'beat', eventId: 'ev-1', beat: { id: 'b-open' } }]),
  { event_id: 'ev-1', beat_id: 'b-open', location_id: '', speaker_id: '' },
  '引擎 current 缺失时从最近 beat 还原',
)

const hookSource = readFileSync(join(here, '../src/hooks/usePlaytest.js'), 'utf8')
assert.match(hookSource, /recordTakenEdge\(edges, 'scene'/, '情节选择写入实际边')
assert.match(hookSource, /recordTakenEdge\(edges, 'event'/, '事件选择或自动单边写入实际边')
assert.match(hookSource, /setTakenEdges\(snap\.takenEdges/, '回退恢复实际边路线')
assert.match(hookSource, /setTakenEdges\(\[\]\)/, '重开清空路线')
assert.match(hookSource, /eventId: eventNode\.id/, '历史 beat 带事件 id 供快照回退')

const panelSource = readFileSync(join(here, '../src/components/PlaytestPanel.jsx'), 'utf8')
assert.match(panelSource, /onContextChange/, '试玩面板上报情景')
assert.match(panelSource, /useLayoutEffect/, '绘制前同步快照，避免被父级 effect 清空')
assert.match(panelSource, /resolvePlaytestCurrent/, '快照位置可从历史还原')
assert.match(panelSource, /playtest\.citeChoice/, '选项可引用给 Agent')
assert.match(panelSource, /c\.edge\?\.id/, '事件边界下一步不提供引用')

const appSource = readFileSync(join(here, '../src/App.jsx'), 'utf8')
assert.match(appSource, /shouldAttachPlaytestContext/, '发送前按板块与版本决定是否附带')
assert.match(appSource, /buildPlaytestRequestPayload/, '请求编入 playtest_context')
assert.match(appSource, /playtestSnapshotRef\.current/, '发送读取同步快照而不是可能被清空的 state')
assert.match(appSource, /board === 'playtest'/, '构建页不读隐藏试玩面板当成本次上下文来源')
assert.match(appSource, /idle: board === 'playtest'/, '试玩页未开局也显示提示')
assert.match(appSource, /setPlaytestFocusEdgeId\(null\)/, '切项目清除精确引用')
assert.match(appSource, /if \(!selectedId\) setPlaytestSnapshot\(null\)/, '切走项目才清空快照')
assert.match(appSource, /setChatCollapsed\(false\)/, '引用选项时展开共享 Agent 面板')

const apiSource = readFileSync(join(here, '../src/api.js'), 'utf8')
assert.match(apiSource, /playtest_context/, 'API 可附带试玩情景')
assert.match(apiSource, /\.\.\.\(playtestContext \? \{\s*playtest_context: playtestContext\s*\} : \{\}\)/, '无情景时保持旧请求体')

const chatSource = readFileSync(join(here, '../src/components/ChatPanel.jsx'), 'utf8')
assert.match(chatSource, /chat-context-chip/, '输入区显示情景标签')

console.log('playtest_context_check: pass')
