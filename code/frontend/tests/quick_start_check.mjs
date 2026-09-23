/**
 * Agent-first 快速上手契约：15 步、双区域高亮、试玩开场/岔路分步。
 *
 * 运行：npm run check:onboarding
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { QUICK_START_STEPS, localizedStepsForMode, resolveStepTargets, stepsForMode } from '../src/onboarding/quickStartSteps.js'
import { playtestGuideTarget, playtestGuideTargetSequence, playtestPanelKey, shouldAdvanceGuidePlaytest, shouldAutoStartGuidePlaytest } from '../src/playtestGuide.js'
import { createTranslator, tZh } from '../src/i18n/translate.js'

const tEn = createTranslator('en-US')

function stepText(step) {
  const body = Array.isArray(step.body) ? step.body.join('\n') : String(step.body || '')
  return `${step.title}\n${body}`
}

const root = dirname(fileURLToPath(import.meta.url))
const overlaySource = readFileSync(join(root, '../src/components/QuickStartOverlay.jsx'), 'utf8')
const styleSource = readFileSync(join(root, '../src/styles.css'), 'utf8')
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')
const chatSource = readFileSync(join(root, '../src/components/ChatPanel.jsx'), 'utf8')
const sceneSource = readFileSync(join(root, '../src/components/SceneForm.jsx'), 'utf8')
const hintSource = readFileSync(join(root, '../src/onboarding/hintStorage.js'), 'utf8')

const normal = stepsForMode('normal')

assert.equal(normal.length, 15, '普通模式 15 步：三栏、输入、请求、结果、展开/核对修改、定位、检查、打开试玩、开场、岔路、再问、收尾')

assert.deepEqual(normal.map((step) => step.id), [
  'layout-sidebar',
  'layout-build',
  'layout-agent',
  'agent-input',
  'agent-example',
  'agent-response',
  'agent-changeset-toggle',
  'agent-changeset-details',
  'agent-locate',
  'check-modified-content',
  'playtest-open',
  'playtest-opening',
  'playtest-result',
  'playtest-agent',
  'finish-normal',
])


assert.equal(normal.find((step) => step.id === 'layout-sidebar').target, 'sidebar')
assert.equal(normal.find((step) => step.id === 'layout-build').target, 'build')
assert.equal(normal.find((step) => step.id === 'layout-agent').target, 'agent')
assert.equal(normal.find((step) => step.id === 'agent-input').target, 'agent-input')
assert.equal(normal.find((step) => step.id === 'agent-example').target, 'agent-example')
assert.equal(normal.find((step) => step.id === 'agent-response').target, 'agent-response')

const agentIndex = normal.findIndex((step) => step.id === 'agent-example')
const responseIndex = normal.findIndex((step) => step.id === 'agent-response')
const inputIndex = normal.findIndex((step) => step.id === 'agent-input')
const checkIndex = normal.findIndex((step) => step.id === 'check-modified-content')
const openingIndex = normal.findIndex((step) => step.id === 'playtest-opening')
const choicesIndex = normal.findIndex((step) => step.id === 'playtest-result')
assert.ok(inputIndex >= 0 && inputIndex < agentIndex, '输入框必须出现在用户请求之前')
assert.ok(agentIndex < responseIndex, '用户请求必须出现在 Agent 回复之前')
assert.ok(responseIndex < checkIndex, 'Agent 回复必须出现在看板定位之前')
assert.ok(openingIndex < choicesIndex, '故事开场必须出现在岔路选择之前')

for (const step of normal) {
  assert.ok(step.reveal, `${step.id} 必须声明完整 reveal`)
  assert.ok(step.reveal.board, `${step.id} 必须声明 board`)
  assert.ok(step.reveal.chatPanel === 'expanded' || step.reveal.chatPanel === 'collapsed', `${step.id} 必须声明 chatPanel`)
  assert.equal(step.nextLabelKey, undefined, `${step.id} 不得使用定位专用下一步文案`)
  const targets = resolveStepTargets(step)
  for (const item of targets) {
    assert.match(item.target, /^[a-z0-9-]+$/, `${step.id} 只能用稳定 data-quickstart`)
  }
}

const toggle = normal.find((step) => step.id === 'agent-changeset-toggle')
const details = normal.find((step) => step.id === 'agent-changeset-details')
const locate = normal.find((step) => step.id === 'agent-locate')
assert.equal(toggle.target, 'agent-changeset-toggle')
assert.equal(toggle.reveal.changesetExpanded, 'collapsed')
assert.equal(details.target, 'agent-changeset')
assert.equal(details.reveal.changesetExpanded, 'expanded')
assert.equal(locate.target, 'agent-locate-first')
assert.equal(locate.reveal.changesetExpanded, 'expanded')

const scene = normal.find((step) => step.id === 'check-modified-content')
assert.equal(scene.reveal.openScene, 'ev-fork')
assert.equal(scene.reveal.sceneBeatId, 'beat-choose')
assert.equal(scene.reveal.eventsSubtab, 'content')
assert.equal(scene.reveal.chatPanel, 'expanded')
assert.equal(scene.reveal.changesetExpanded, 'expanded')
assert.deepEqual(
  resolveStepTargets(scene).map((item) => item.target),
  ['agent-change-detail-first', 'scene-content-field'],
)
assert.equal(resolveStepTargets(scene)[0].labelKey, 'help.overlay.changeRecord')
assert.equal(resolveStepTargets(scene)[1].labelKey, 'help.overlay.contentLocation')

const playtestOpen = normal.find((step) => step.id === 'playtest-open')
const playtestOpening = normal.find((step) => step.id === 'playtest-opening')
const playtestResult = normal.find((step) => step.id === 'playtest-result')
const playtestAgent = normal.find((step) => step.id === 'playtest-agent')
assert.deepEqual(
  resolveStepTargets(playtestOpen).map((item) => item.target),
  ['build-tab', 'playtest-tab'],
)
assert.equal(playtestOpen.reveal.board, 'build')
assert.equal(playtestOpen.reveal.openScene, 'ev-fork')
assert.equal(playtestOpen.reveal.sceneBeatId, 'beat-choose')
assert.equal(playtestOpen.reveal.chatPanel, 'expanded')
assert.equal(playtestOpening.target, 'playtest-stage')
assert.equal(playtestGuideTarget(playtestOpening.reveal), 'start')
assert.equal(playtestOpening.reveal.changesetExpanded, 'collapsed')
assert.equal(playtestGuideTarget(playtestResult.reveal), 'choices')
assert.equal(playtestGuideTarget(playtestAgent.reveal), 'choices')
assert.equal(playtestResult.reveal.chatPanel, 'expanded')
assert.equal(playtestAgent.reveal.chatPanel, 'expanded')
assert.equal(playtestAgent.target, 'playtest-context')

assert.deepEqual(
  playtestGuideTargetSequence(normal, [
    'playtest-opening',
    'playtest-result',
    'playtest-agent',
    'playtest-result',
    'playtest-opening',
  ]),
  ['start', 'choices', 'choices', 'choices', 'start'],
  '前进后退都必须按 start → choices → context 重建画面',
)

const localized = localizedStepsForMode('normal', tZh)
assert.match(stepText(localized.find((step) => step.id === 'agent-example')), /处理对象|选择问句/)
assert.match(stepText(localized.find((step) => step.id === 'agent-response')), /处理结果|修改记录/)
assert.match(stepText(localized.find((step) => step.id === 'agent-input')), /输入希望 Agent 完成的工作/)
assert.match(stepText(localized.find((step) => step.id === 'layout-build')), /项目工作区/)
assert.match(stepText(localized.find((step) => step.id === 'layout-sidebar')), /收起或重新展开左侧面板/)
assert.match(stepText(localized.find((step) => step.id === 'layout-agent')), /收起或重新展开该面板/)
assert.match(stepText(localized.find((step) => step.id === 'agent-changeset-toggle')), /查看细节|折叠行已经显示/)
assert.match(stepText(localized.find((step) => step.id === 'agent-changeset-details')), /修改前后内容/)
assert.match(stepText(localized.find((step) => step.id === 'agent-locate')), /每条修改右侧都有「定位」按钮/)
assert.match(stepText(localized.find((step) => step.id === 'check-modified-content')), /同一句|修改记录|内容位置/)
assert.match(stepText(localized.find((step) => step.id === 'playtest-open')), /构建.*试玩|查看和编辑项目内容/)
assert.match(stepText(localized.find((step) => step.id === 'playtest-opening')), /故事开头/)
assert.match(stepText(localized.find((step) => step.id === 'playtest-result')), /岔路口/)
assert.match(stepText(localized.find((step) => step.id === 'finish-normal')), /概念说明/)




const localizedEn = localizedStepsForMode('normal', tEn)
assert.match(stepText(localizedEn.find((step) => step.id === 'agent-changeset-toggle')), /View changes/)
assert.match(stepText(localizedEn.find((step) => step.id === 'agent-locate')), /Locate button/)
assert.match(stepText(localizedEn.find((step) => step.id === 'check-modified-content')), /same sentence/)
assert.match(stepText(localizedEn.find((step) => step.id === 'playtest-opening')), /beginning of the story/)
assert.match(stepText(localizedEn.find((step) => step.id === 'playtest-result')), /fork/)

const joined = QUICK_START_STEPS.flatMap((step) => [step.title, ...(Array.isArray(step.body) ? step.body : [step.body])]).join('\n')
const localizedJoined = [...localized, ...localizedEn]
  .flatMap((step) => [step.title, ...(Array.isArray(step.body) ? step.body : [step.body])])
  .join('\n')
assert.match(joined, /项目工作区/)
assert.match(joined, /检查修改内容/)
assert.doesNotMatch(joined, /不会变成你的作品/)
assert.doesNotMatch(joined, /不能在这里发送/)
assert.doesNotMatch(joined, /revision/)
assert.doesNotMatch(joined, /flag \/ enum \/ scalar/)
assert.doesNotMatch(joined, /定位到修改/)
assert.doesNotMatch(joined, /实际使用时/)
assert.doesNotMatch(joined, /导览中/)
assert.doesNotMatch(joined, /不会从当前/)
assert.doesNotMatch(joined, /覆盖层/)
assert.doesNotMatch(localizedJoined, /实际使用时|导览中|不会从当前|In actual use|During the tour|will not continue/)

assert.match(overlaySource, /step\.nextLabelKey \? t\(step\.nextLabelKey\)/)
assert.match(overlaySource, /resolveStepTargets/)
assert.match(overlaySource, /quickstart-holes/)
assert.match(styleSource, /\.quickstart-spotlight \{[\s\S]*pointer-events:\s*auto/)
assert.doesNotMatch(
  styleSource,
  /\.quickstart-spotlight \{[^}]*pointer-events:\s*none/,
  '圈选区域必须截获点击，不能穿透到定位/保留/撤销',
)
assert.match(styleSource, /\.quickstart-spotlight-label/)
assert.match(chatSource, /data-quickstart=\{index === 0 \? 'agent-locate-first'/)
assert.match(chatSource, /data-quickstart=\{index === 0 \? 'agent-change-detail-first'/)
assert.match(chatSource, /agent\.chat\.viewDetails/)
assert.match(chatSource, /agent\.chat\.collapseDetails/)
assert.doesNotMatch(chatSource, /expanded \? t\('common\.collapse'\) : t\('common\.view'\)/)
assert.match(chatSource, /data-quickstart="playtest-context"/)
assert.match(chatSource, /data-quickstart=\{isUser \? 'agent-example'/)
assert.match(chatSource, /data-quickstart=\{!isUser && msg\.changeset\?\.counts\?\.total \? 'agent-response'/)
assert.match(chatSource, /data-quickstart="agent-input"/)
assert.match(chatSource, /data-quickstart="agent-changeset-toggle"/)
assert.match(chatSource, /changesetExpanded === 'expanded'/)
assert.match(chatSource, /changesetExpanded === 'collapsed'/)
assert.match(sceneSource, /dataQuickstart="scene-content-field"/)
assert.match(overlaySource, /event-inspector, \.drawer-body, \.chat-scroll/)
assert.match(overlaySource, /nearestTargetNode/)
assert.match(appSource, /setTourChangesetExpanded\(reveal\.changesetExpanded \|\| null\)/)
assert.doesNotMatch(appSource, /quickStartStepId === 'agent-changeset-details'/)
assert.doesNotMatch(appSource, /quickStartStepId === 'agent-changeset-toggle'/)
assert.match(appSource, /setTourChatCollapsed\(reveal\.chatPanel === 'collapsed'\)/)
assert.match(appSource, /data-quickstart="playtest-tab"/)
assert.match(appSource, /data-quickstart="build-tab"/)
assert.doesNotMatch(appSource, /data-quickstart="playtest"/)
assert.match(appSource, /clearProgress/)
assert.match(appSource, /leaveQuickStart\(\{\s*restoreSnapshot: true,\s*clearProgress: true\s*\}\)/)
assert.match(appSource, /onDismiss=\{\(\) => \{[\s\S]*leaveQuickStart\(\{\s*restoreSnapshot: true\s*\}\)/)
assert.doesNotMatch(appSource, /onDismiss=\{\(\) => \{[\s\S]*clearProgress: true/)
assert.match(hintSource, /QUICK_START_FLOW_VERSION = 6/)

assert.equal(shouldAutoStartGuidePlaytest('start'), true)
assert.equal(shouldAutoStartGuidePlaytest('choices'), true)
assert.equal(shouldAdvanceGuidePlaytest('start', 1), false)
assert.equal(shouldAdvanceGuidePlaytest('choices', 1), true)
assert.equal(shouldAdvanceGuidePlaytest('choices', 2), false)
assert.equal(playtestPanelKey('demo-1', { isDemo: true, guideSessionSeq: 3 }), 'demo-1:guide:3')
assert.equal(playtestPanelKey('proj-1', { isDemo: false, guideSessionSeq: 3 }), 'proj-1')

assert.match(appSource, /playtestPanelKey\(selectedId/)
assert.match(appSource, /isDemo: isDemoProject/)
assert.match(appSource, /playtestTarget=\{isDemoProject \? quickStartPlaytestTarget : null\}/)

console.log('quick start checks passed')
