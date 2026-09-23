/**
 * 概念注册表、搜索、情境提示和导航保护。
 *
 * 运行：npm run check:concept-help
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONCEPTS,
  canNavigateConcept,
  getConcept,
  groupConceptsByCategory,
  listConceptIds,
  relatedConcepts,
  resolveConceptDestination,
  searchConcepts,
} from '../src/onboarding/concepts.js'
import { CONTEXTUAL_HINTS, pickContextualHint } from '../src/onboarding/contextualHints.js'
import {
  buildPageViewKey,
  buildViewKey,
  collectChangesetIds,
  normalizeInspectorFocus,
  resolveVisibleInspector,
  visibleInspectorFocus,
} from '../src/onboarding/contextualView.js'
import { dictionaries } from '../src/i18n/dictionaries/index.js'
import { createTranslator, tZh } from '../src/i18n/translate.js'

const root = dirname(fileURLToPath(import.meta.url))
const triggerSource = readFileSync(join(root, '../src/components/ConceptHelpContext.jsx'), 'utf8')
const hintSource = readFileSync(join(root, '../src/components/ContextualHint.jsx'), 'utf8')
const panelSource = readFileSync(join(root, '../src/components/ConceptHelpPanel.jsx'), 'utf8')

const ids = listConceptIds()
assert.equal(new Set(ids).size, ids.length, 'conceptId 必须唯一')
assert.ok(ids.includes('agent') && ids.includes('variableTypes') && ids.includes('playtest'))

const tEn = createTranslator('en-US')
for (const id of ids) {
  for (const locale of ['zh-CN', 'en-US']) {
    const concept = dictionaries[locale].help.concept[id]
    assert.ok(concept, `${locale} 缺少概念 ${id}`)
    for (const field of ['term', 'summary', 'why', 'example', 'where']) {
      assert.equal(typeof concept[field], 'string', `${locale} ${id}.${field} 必须是字符串`)
      assert.ok(concept[field].trim(), `${locale} ${id}.${field} 不能为空`)
    }
  }
  assert.ok(getConcept(id), `getConcept(${id})`)
}

assert.equal(getConcept('not-a-real-concept'), null, '未知 id 必须安全回到总览')
assert.match(panelSource, /getConcept\(initialConceptId\) \? initialConceptId : null/)

const found = searchConcepts('状态变量', tZh)
assert.ok(found.some((item) => item.id === 'stateVariable'))
assert.ok(searchConcepts('Which way', tEn).some((item) => item.id === 'beat' || item.id === 'choice' || item.id === 'playtest'))
assert.equal(searchConcepts('zzzz-no-such-term', tZh).length, 0)

const groups = groupConceptsByCategory()
assert.deepEqual(groups.map((group) => group.id), ['workflow', 'artifacts', 'structure', 'state', 'check'])
assert.ok(relatedConcepts('agent').every((item) => getConcept(item.id)))
assert.deepEqual(relatedConcepts('missing'), [])

const sceneDest = resolveConceptDestination('beat', { selectedEventId: 'ev-fork' })
assert.equal(sceneDest.openScene, 'ev-fork')
const fallback = resolveConceptDestination('beat', { selectedEventId: null })
assert.equal(fallback.eventsSubtab, 'content')
assert.equal(fallback.openScene, null)

assert.equal(canNavigateConcept({ conceptId: 'agent' }).reason, 'none')
assert.equal(canNavigateConcept({
  conceptId: 'playtest',
  hasProject: true,
  isDemo: true,
}).reason, 'demo')
assert.equal(canNavigateConcept({
  conceptId: 'validation',
  hasProject: false,
}).reason, 'unavailable')
assert.equal(canNavigateConcept({
  conceptId: 'eventNetwork',
  hasProject: true,
  hasDirtyDraft: true,
}).reason, 'dirty')
assert.equal(canNavigateConcept({
  conceptId: 'eventNetwork',
  hasProject: true,
}).allowed, true)

assert.equal(CONTEXTUAL_HINTS.length, 21, '情境提示共 21 条：6 条检查器、11 条页面/起步、4 条操作结果')
assert.deepEqual(CONTEXTUAL_HINTS.map((hint) => hint.id), [
  'firstWorldCardInspector',
  'firstEventNodeInspector',
  'firstEventEdgeInspector',
  'firstSceneBeatInspector',
  'firstSceneEdgeInspector',
  'firstVariableInspector',
  'firstEmptyProjectAgent',
  'firstMaterials',
  'firstIntent',
  'firstOutline',
  'firstWorld',
  'firstEventNetwork',
  'firstEventList',
  'firstSceneNetwork',
  'firstVariables',
  'firstValidation',
  'firstPlaytest',
  'firstChangesetLocate',
  'firstChangeset',
  'firstLockedChoice',
  'firstSaveUnchecked',
])
for (const hint of CONTEXTUAL_HINTS) {
  assert.ok(getConcept(hint.conceptId), `提示 ${hint.id} 必须指向有效概念`)
  assert.ok(['inspector', 'page', 'operation'].includes(hint.tier), `提示 ${hint.id} 必须声明层级`)
  for (const locale of ['zh-CN', 'en-US']) {
    const copy = dictionaries[locale].help.hints[hint.id]
    assert.ok(copy?.title && copy?.body, `${locale} 缺少提示文案 ${hint.id}`)
  }
}
assert.equal(dictionaries['zh-CN'].help.hints.firstLocatedScene, undefined)
assert.match(tZh('help.hints.firstWorldCardInspector.body'), /上传|更换配图|一键生图|重新生图/)
assert.match(tZh('help.hints.firstWorldCardInspector.body'), /立绘|背景/)
assert.match(tZh('help.hints.firstChangesetLocate.body'), /定位/)
assert.equal(pickContextualHint({ locatedViaAgent: true, activeTab: 'events', hasProject: true })?.id, undefined)

assert.equal(normalizeInspectorFocus({ kind: 'world-card', id: 'c1', category: 'characters' }).kind, 'world-card')
assert.equal(normalizeInspectorFocus({ kind: 'unknown' }), null)
assert.equal(visibleInspectorFocus(
  { kind: 'event-node', id: 'n1' },
  { board: 'build', activeTab: 'events', eventsSubtab: 'content', sceneView: 'list' },
), null, '隐藏但仍挂载的事件检查器不得继续贡献')
assert.equal(resolveVisibleInspector(
  { world: { kind: 'world-card', id: 'c1' }, event: { kind: 'event-node', id: 'n1' } },
  { board: 'build', activeTab: 'intent' },
), null)
assert.equal(resolveVisibleInspector(
  { event: { kind: 'event-node', id: 'n1' } },
  { board: 'build', activeTab: 'events', eventsSubtab: 'network' },
)?.kind, 'event-node')
assert.equal(resolveVisibleInspector(
  { scene: { kind: 'scene-beat', id: 'b1' } },
  { board: 'build', activeTab: 'events', eventsSubtab: 'content', sceneView: 'list' },
), null)
const intentView = buildViewKey({ board: 'build', activeTab: 'intent' })
const worldCardView = buildViewKey({
  board: 'build',
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
})
assert.equal(intentView, 'build/intent///')
assert.equal(worldCardView, 'build/world///world-card')
assert.equal(buildPageViewKey({
  board: 'build',
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
}), 'build/world///')
assert.deepEqual([...collectChangesetIds([
  { changeset: { id: 'cs-1', counts: { total: 2 } } },
  { changeset: { id: 'cs-empty', counts: { total: 0 } } },
  { text: 'no changeset' },
])], ['cs-1'])

const projectCtx = { hasProject: true, board: 'build', seen: {} }
assert.equal(pickContextualHint({
  ...projectCtx,
  newlyCreatedEmptyProject: true,
  board: 'build',
  activeTab: 'materials',
})?.id, 'firstEmptyProjectAgent')
assert.equal(pickContextualHint({
  ...projectCtx,
  newlyCreatedEmptyProject: true,
  board: 'build',
  activeTab: 'materials',
})?.id, 'firstEmptyProjectAgent', '新建空项目时不连续弹出素材介绍')
assert.equal(pickContextualHint({
  ...projectCtx,
  newlyCreatedEmptyProject: true,
  board: 'build',
  activeTab: 'materials',
  hasChangeset: true,
})?.id, 'firstChangeset', '空项目里一旦有修改摘要，也先讲摘要')
assert.equal(pickContextualHint({
  ...projectCtx,
  board: 'build',
  activeTab: 'materials',
})?.id, 'firstMaterials')
assert.equal(pickContextualHint({ ...projectCtx, activeTab: 'intent' })?.id, 'firstIntent')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  hasChangeset: true,
  viewKey: intentView,
})?.id, 'firstChangeset', '项目里已有修改摘要时，先讲摘要，不要求先点掉页面介绍')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
  hasChangeset: true,
})?.id, 'firstWorldCardInspector', '打开检查器仍优先于修改摘要')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  hasChangeset: true,
  changesetDetailsOpen: true,
})?.id, 'firstChangesetLocate', '展开细节且有定位时先讲定位')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
  hasChangeset: true,
  changesetDetailsOpen: true,
})?.id, 'firstWorldCardInspector', '检查器仍优先于定位提示')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  hasChangeset: true,
  changesetDetailsOpen: true,
  seen: { firstChangesetLocate: true },
})?.id, 'firstChangeset', '定位提示看过后回到摘要介绍')
assert.equal(pickContextualHint({ ...projectCtx, activeTab: 'outline' })?.id, 'firstOutline')
assert.equal(pickContextualHint({ ...projectCtx, activeTab: 'world' })?.id, 'firstWorld')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
})?.id, 'firstWorldCardInspector', '打开检查器优先于页面介绍')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'network',
  sceneView: 'list',
})?.id, 'firstEventNetwork')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'network',
  inspectorFocus: { kind: 'event-node', id: 'n1' },
})?.id, 'firstEventNodeInspector')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'network',
  inspectorFocus: { kind: 'event-edge', id: 'e1' },
})?.id, 'firstEventEdgeInspector')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'content',
  sceneView: 'list',
})?.id, 'firstEventList')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'content',
  sceneView: 'scene',
})?.id, 'firstSceneNetwork')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'content',
  sceneView: 'scene',
  inspectorFocus: { kind: 'scene-beat', id: 'b1' },
})?.id, 'firstSceneBeatInspector')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'content',
  sceneView: 'scene',
  inspectorFocus: { kind: 'scene-edge', id: 'se1' },
})?.id, 'firstSceneEdgeInspector')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'variables',
  sceneView: 'list',
})?.id, 'firstVariables')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'variables',
  inspectorFocus: { kind: 'variable', id: 'v1' },
})?.id, 'firstVariableInspector', '变量检查器与页面介绍分开')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'events',
  eventsSubtab: 'validation',
  sceneView: 'list',
})?.id, 'firstValidation')
assert.equal(pickContextualHint({ hasProject: true, board: 'playtest' })?.id, 'firstPlaytest')
assert.equal(pickContextualHint({
  ...projectCtx,
  board: 'playtest',
  hasLockedChoice: true,
})?.id, 'firstPlaytest', '页面介绍优先于锁定选择')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  viewKey: intentView,
  hasChangeset: true,
  seen: { firstChangeset: true },
})?.id, 'firstIntent', '摘要看过后才轮到当前页介绍')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'outline',
  viewKey: 'build/outline///',
  hasChangeset: true,
})?.id, 'firstChangeset', '修改摘要不要求仍停在摘要刚出现的那一页')
assert.equal(pickContextualHint({
  ...projectCtx,
  board: 'playtest',
  hasLockedChoice: true,
  seen: { firstPlaytest: true },
})?.id, 'firstLockedChoice')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'materials',
  viewKey: 'build/materials///',
  pageViewKey: 'build/materials///',
  pendingSaveViewKey: 'build/materials///',
  validationStatus: 'not_checked',
  seen: { firstMaterials: true },
})?.id, 'firstSaveUnchecked')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'world',
  viewKey: worldCardView,
  pageViewKey: 'build/world///',
  pendingSaveViewKey: 'build/world///',
  validationStatus: 'not_checked',
  seen: { firstWorld: true, firstWorldCardInspector: true },
})?.id, 'firstSaveUnchecked', '尚未检测绑页面，打开设定卡不会弄丢')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'intent',
  viewKey: intentView,
  pageViewKey: intentView,
  pendingSaveViewKey: 'build/materials///',
  validationStatus: 'not_checked',
  seen: { firstIntent: true },
})?.id, undefined, '尚未检测只在保存时的页面重现')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
  seen: { firstWorldCardInspector: true },
})?.id, 'firstWorld', '检查器看过后回到页面介绍')
assert.equal(pickContextualHint({
  ...projectCtx,
  activeTab: 'world',
  inspectorFocus: { kind: 'world-card', id: 'c1' },
  seen: { firstWorldCardInspector: true, firstWorld: true },
})?.id, undefined, 'seen 后不重复')

assert.equal(pickContextualHint({
  hasProject: true,
  quickStartOpen: true,
  inspectorFocus: { kind: 'world-card', id: 'c1' },
}), null)
assert.equal(pickContextualHint({
  hasProject: true,
  isDemo: true,
  board: 'playtest',
}), null)


assert.equal(pickContextualHint({
  hasProject: true,
  conceptHelpOpen: true,
  activeTab: 'intent',
  board: 'build',
}), null)
assert.equal(pickContextualHint({
  hasProject: true,
  projectSwitching: true,
  newlyCreatedEmptyProject: true,
}), null)

assert.equal(pickContextualHint({
  hasChangeset: true,
  viewKey: intentView,
  seen: {},
}), null, '没有真实项目不弹')
assert.equal(pickContextualHint({
  hasProject: true,
  viewKey: intentView,
  hasChangeset: true,
  seen: { firstChangeset: true },
}), null)
assert.equal(pickContextualHint({
  hasProject: true,
  validationStatus: 'not_checked',
  hasSavedContent: true,
}), null, '没有绑定当前视图的保存事件不弹尚未检测')
assert.match(tZh('help.hints.firstValidation.body'), /不可达内容|死路|缺失情节|无效引用/)
assert.match(tZh('help.hints.firstValidation.body'), /不评价故事质量/)

assert.match(triggerSource, /type="button"/)
assert.match(triggerSource, /help\.center\.learnAbout/)
assert.doesNotMatch(triggerSource, /readSeenHints|markHintSeen/)
assert.match(hintSource, /onLearnMore/)
assert.match(hintSource, /help\.center\.learnMore/)
assert.match(hintSource, /btn btn-ghost/)
assert.doesNotMatch(hintSource, /className="btn ghost"/)
assert.match(hintSource, /contextual-hint-copy/)

const styleSource = readFileSync(join(root, '../src/styles.css'), 'utf8')
assert.match(styleSource, /\.contextual-hint-copy \{\s*flex: 1;\s*min-width: 0;/)
assert.match(styleSource, /\.contextual-hint-actions \{[\s\S]*flex: 0 0 auto;/)
assert.match(styleSource, /\.contextual-hint-actions \{[\s\S]*flex-wrap: nowrap;/)
assert.match(styleSource, /\.contextual-hint-actions \.btn \{\s*white-space: nowrap;/)
assert.match(styleSource, /@media \(max-width: 560px\) \{[\s\S]*\.contextual-hint \{[\s\S]*flex-direction: column;/)
assert.match(styleSource, /\.contextual-hint \{[\s\S]*z-index: 60;/, '提示叠在设定卡抽屉之上')

const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')
assert.match(appSource, /setCreatedEmptyProjectId\(p\.id\)/)
assert.match(appSource, /createdEmptyProjectId && selectedId !== createdEmptyProjectId/)
assert.match(appSource, /board !== 'build' \|\| activeTab !== 'materials'/)
assert.match(appSource, /handleSceneViewChange/)
assert.match(appSource, /eventsSubtab === 'content'/)
assert.match(appSource, /hasChangeset: messages/)
assert.match(appSource, /changesetDetailsOpen/)
assert.match(appSource, /onChangesetDetailsChange=\{setChangesetDetailsOpen\}/)
assert.match(appSource, /recordSaveUncheckedHint/)
assert.match(appSource, /handleWorldInspectorChange/)
assert.match(appSource, /handleEventInspectorChange/)
assert.match(appSource, /handleSceneInspectorChange/)
assert.match(appSource, /buildPageViewKey/)
assert.doesNotMatch(appSource, /locatedViaAgent/)
assert.doesNotMatch(appSource, /firstLocatedScene/)
assert.doesNotMatch(appSource, /pendingChangesetViewKey/)

const cardGridSource = readFileSync(join(root, '../src/components/fields/CardGrid.jsx'), 'utf8')
assert.match(cardGridSource, /onInspectorChange/, '设定卡抽屉向情境提示上报')
assert.match(cardGridSource, /kind: 'world-card'/)
assert.match(cardGridSource, /previewNewCard \|\| current == null/)

const worldFormSource = readFileSync(join(root, '../src/components/WorldForm.jsx'), 'utf8')
assert.match(worldFormSource, /onInspectorChange=\{onInspectorChange\}/)

const eventFormSource = readFileSync(join(root, '../src/components/EventForm.jsx'), 'utf8')
assert.match(eventFormSource, /kind: 'event-node'/)
assert.match(eventFormSource, /kind: 'event-edge'/)
assert.match(eventFormSource, /kind: 'variable'/)
assert.match(eventFormSource, /view !== 'network'/)
assert.match(eventFormSource, /active=\{view === 'variables'\}/)

const sceneFormSource = readFileSync(join(root, '../src/components/SceneForm.jsx'), 'utf8')
assert.match(sceneFormSource, /kind: 'scene-beat'/)
assert.match(sceneFormSource, /kind: 'scene-edge'/)

const chatPanelSource = readFileSync(join(root, '../src/components/ChatPanel.jsx'), 'utf8')
assert.match(chatPanelSource, /onDetailsChange/)
assert.match(chatPanelSource, /hasLocate/)
assert.match(chatPanelSource, /handleChangesetDetailsChange/)
assert.match(chatPanelSource, /onChangesetDetailsChange/)

console.log('concept help checks passed')
