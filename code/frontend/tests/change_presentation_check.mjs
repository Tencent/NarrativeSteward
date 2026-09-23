/**
 * Agent 修改摘要领域展示与定位规则的无浏览器回归检查。
 *
 * 运行：npm run check:changeset
 */

import assert from 'node:assert/strict'

import {
  changeDetailLabel,
  changeNavigation,
  formatChangeValue,
  rawChangeValue,
} from '../src/changePresentation.js'

const addedScene = {
  operation: 'add',
  object_type: 'scene',
  object_id: 'event-opening',
  field: null,
  after: {
    event_id: 'event-opening',
    beats: [
      {
        id: 'beat-opening',
        kind: 'narration',
        content: '夜色笼罩着城堡。',
        location: 'castle',
        effects: [],
      },
    ],
    edges: [],
  },
}

assert.equal(
  formatChangeValue(addedScene, addedScene.after),
  '情节节点：1 个\n玩家选择：0 条\n开场：夜色笼罩着城堡。',
  '整个情节新增应显示数量和开场摘要，而不是裸 JSON',
)
assert.deepEqual(
  changeNavigation(addedScene),
  { enabled: true, label: '查看情节图', selectObject: false },
  '整个情节只打开所属事件，不把 event id 当作 beat id',
)

const addedCharacter = {
  operation: 'add',
  object_type: 'character',
  object_id: 'char-guide',
  field: null,
  after: {
    id: 'char-guide',
    name: '向导',
    description: '熟悉旧城道路。',
    tags: ['盟友', '本地人'],
    image: '',
  },
}
assert.equal(
  changeDetailLabel(addedCharacter),
  '角色卡片「向导」',
  '角色设定标题应写成角色卡片加名称',
)
assert.equal(
  changeDetailLabel({
    operation: 'add',
    object_type: 'worldview',
    after: { name: '旧城法则' },
  }),
  '世界观卡片「旧城法则」',
)
assert.equal(
  changeDetailLabel({
    operation: 'add',
    object_type: 'location',
    after: { name: '码头' },
  }),
  '地点卡片「码头」',
)
assert.equal(
  changeDetailLabel({
    operation: 'add',
    object_type: 'faction',
    after: { name: '商会' },
  }),
  '势力卡片「商会」',
)
assert.equal(
  changeDetailLabel({
    operation: 'add',
    object_type: 'history',
    after: { name: '开埠' },
  }),
  '历史卡片「开埠」',
)
assert.equal(
  changeDetailLabel({
    operation: 'add',
    object_type: 'other',
    after: { name: '潮汐表' },
  }),
  '其他卡片「潮汐表」',
  '其他分类应写成其他卡片，不写设定卡片',
)
assert.match(
  formatChangeValue(addedCharacter, addedCharacter.after),
  /名称：向导[\s\S]*标签：盟友、本地人/,
  '设定卡片应按中文字段展示',
)

const addedIntentLines = {
  operation: 'add',
  data_type: 'intent',
  object_type: 'text',
  field: 'lines',
  after: '第三行',
}
assert.equal(
  changeDetailLabel(addedIntentLines),
  '创作意图的一段',
  '意图行级新增应写面板名加「的一段」，不写「文本的文本」',
)

const modifiedOutlineLines = {
  operation: 'modify',
  data_type: 'outline',
  object_type: 'text',
  field: 'lines',
  before: '旧大纲',
  after: '新大纲',
}
assert.equal(
  changeDetailLabel(modifiedOutlineLines),
  '故事大纲的一段',
  '大纲行级修改应写故事大纲的一段',
)

const renamedCharacter = {
  operation: 'modify',
  object_type: 'character',
  object_id: 'char-hero',
  field: 'name',
  before: '旧名字',
  after: '新名字',
}
assert.equal(
  changeDetailLabel(renamedCharacter),
  '角色卡片的名称',
  '只改名称且当前值是字符串时，标题不把新名字叠进对象名',
)

const addedAsset = {
  operation: 'add',
  object_type: 'asset',
  object_id: 'generated.png',
  field: null,
  after: { filename: 'generated.png', sha256: 'abc123def456' },
}
assert.equal(
  changeDetailLabel(addedAsset),
  '配图「generated.png」',
  '配图标题应带文件名',
)

const modifiedEffects = {
  operation: 'modify',
  object_type: 'beat',
  object_id: 'beat-opening',
  field: 'effects',
}
assert.equal(
  formatChangeValue(modifiedEffects, [{ var: 'trust', op: 'add', value: 1 }]),
  'trust 增加 1',
  '状态变化数组应显示自然语言',
)

const removedEvent = {
  operation: 'remove',
  object_type: 'event',
  object_id: 'event-old',
  field: null,
}
assert.deepEqual(
  changeNavigation(removedEvent),
  { enabled: true, label: '打开所属面板', selectObject: false },
  '删除项只打开所属面板，不再选择已删除对象',
)

const asset = {
  operation: 'add',
  object_type: 'asset',
  object_id: 'generated.png',
  field: null,
}
assert.equal(
  changeNavigation(asset).enabled,
  false,
  '没有稳定卡片归属的资产不应显示伪定位',
)

assert.match(
  rawChangeValue(addedScene.after),
  /"beats":/,
  '结构化值仍应保留完整原始数据供精确复核',
)

const tq1EventEdge = {
  operation: 'modify',
  object_type: 'event_edge',
  object_id: 'e-open',
  field: 'value',
  location: {
    board: 'events',
    subtab: 'network',
    object_type: 'event_edge',
    object_id: 'e-open',
  },
}
assert.deepEqual(
  changeNavigation(tq1EventEdge),
  { enabled: true, label: '定位', selectObject: true },
  'TQ1 事件边条件修改应定位到事件网络中的该边',
)
assert.equal(tq1EventEdge.location.board, 'events')
assert.equal(tq1EventEdge.location.subtab, 'network')

const tq1Beat = {
  operation: 'modify',
  object_type: 'beat',
  object_id: 'start-b0',
  field: 'content',
  location: {
    board: 'events',
    subtab: 'content',
    event_id: 'start',
    object_type: 'beat',
    object_id: 'start-b0',
  },
}
assert.deepEqual(
  changeNavigation(tq1Beat),
  { enabled: true, label: '定位', selectObject: true },
  'TQ1 同层 beat 文本修改应定位到该事件的情节对象',
)
assert.equal(tq1Beat.location.subtab, 'content')

const tq1LocationCard = {
  operation: 'add',
  object_type: 'location',
  object_id: 'loc-annex',
  field: null,
  after: { id: 'loc-annex', name: '侧厅' },
  location: {
    board: 'world',
    object_type: 'location',
    object_id: 'loc-annex',
  },
}
assert.equal(changeDetailLabel(tq1LocationCard), '地点卡片「侧厅」')
assert.deepEqual(
  changeNavigation(tq1LocationCard),
  { enabled: true, label: '定位', selectObject: true },
  'TQ1 跨层新增地点卡应定位到设定面板对象',
)

console.log('PASS: Agent 修改摘要展示与定位规则')
