/**
 * 情节网络连续呈现：last-good、乱序响应、终态必须等到总览与已打开情节。
 *
 * 运行：node tests/scene_network_recovery_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { selectDisplayedGraph } from '../src/graphContinuity.js'
import { createSceneResourceController } from '../src/hooks/useSceneResource.js'

const root = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(join(root, '../src/components/ScenePanel.jsx'), 'utf8')
const formSource = readFileSync(join(root, '../src/components/SceneForm.jsx'), 'utf8')
const graphSource = readFileSync(join(root, '../src/components/SceneGraphView.jsx'), 'utf8')
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

{
  const lastGood = { beats: [{ id: 'beat-1' }], edges: [] }
  const kept = selectDisplayedGraph(lastGood, { beats: [] }, { loading: true, generating: true })
  assert.equal(kept.displayed, lastGood, '情节刷新空候选时继续显示上一份图')
  const confirmed = selectDisplayedGraph(lastGood, { beats: [] }, {
    authoritative: true,
    confirmedEmpty: true,
  })
  assert.equal(confirmed.phase, 'confirmed_empty', '正式确认未生成后才清空')
}

{
  const slowA = createDeferred()
  const calls = []
  const controller = createSceneResourceController({
    listScenes: async () => ({ scenes: [{ event_id: 'A', has_scene: true }] }),
    getScene: async (_projectId, eventId) => {
      calls.push(eventId)
      if (eventId === 'A' && calls.filter((id) => id === 'A').length === 1) {
        return slowA.promise
      }
      return {
        event_id: eventId,
        has_scene: true,
        content: { beats: [{ id: `${eventId}-fast` }], edges: [] },
      }
    },
  })

  const first = controller.loadScene('p1', 'A')
  const second = controller.loadScene('p1', 'A')
  const other = await controller.loadScene('p1', 'B')
  slowA.resolve({
    event_id: 'A',
    has_scene: true,
    content: { beats: [{ id: 'A-slow' }], edges: [] },
  })
  const firstResult = await first
  const secondResult = await second
  assert.equal(firstResult.stale, true, '同一事件的旧请求不能覆盖新请求')
  assert.equal(secondResult.scene.content.beats[0].id, 'A-fast')
  assert.equal(other.scene.content.beats[0].id, 'B-fast')
  assert.equal(controller.snapshot().scenes.A.content.beats[0].id, 'A-fast')
}

{
  const controller = createSceneResourceController({
    listScenes: async () => ({ scenes: [{ event_id: 'A', has_scene: true }] }),
    getScene: async () => {
      throw new Error('scene missing')
    },
  })
  await assert.rejects(() => controller.reconcileVisible('p1', 'A'), /scene missing/)
  assert.equal(controller.snapshot().overview?.length, 1, '总览成功后失败的情节读取仍保留总览')
}

{
  const controller = createSceneResourceController({
    listScenes: async () => {
      throw new Error('overview missing')
    },
    getScene: async () => ({ event_id: 'A', content: { beats: [{ id: 'x' }] } }),
  })
  await assert.rejects(() => controller.reconcileVisible('p1', 'A'), /overview missing/)
}

{
  const controller = createSceneResourceController({
    listScenes: async () => ({ scenes: [] }),
    getScene: async () => ({
      event_id: 'A',
      has_scene: false,
      content: { beats: [], edges: [] },
    }),
  })
  await controller.loadScene('p1', 'A')
  assert.ok(controller.snapshot().scenes.A, '非权威空结果在没有 last-good 时可以记下候选')
  await controller.loadScene('p1', 'A', { authoritative: true })
  assert.equal(controller.snapshot().scenes.A, undefined, '权威确认未生成后清空该事件缓存')
}

assert.doesNotMatch(panelSource, /加载情节中/, '刷新已打开情节不得换成整页加载占位')
assert.doesNotMatch(panelSource, /loadingScene \|\| !scene/, '不得因 loading 卸载 SceneForm')
assert.match(panelSource, /onReconcileReady/, '终态对账可等待情节总览与已打开情节')
assert.match(panelSource, /graphOverlayText/, '情节刷新用非阻塞覆盖层')
assert.match(formSource, /refreshing/, 'SceneForm 接受刷新中只读')
assert.match(graphSource, /createViewportFitScheduler/, '情节图画布共用视口调度')
assert.doesNotMatch(graphSource, /^\s*fitView\s*$/m, '情节图不再使用初始化用的裸 fitView')
assert.match(graphSource, /适应全图/, '情节图提供适应全图入口')
assert.match(appSource, /sceneReconcileRef/, '终态恢复等待情节对账')
assert.match(appSource, /handleSceneReconcileReady/, 'ScenePanel 注册可见情节对账')
{
  const restoreSource = appSource.match(
    /const loadCanonicalWorkspace = useCallback\([\s\S]*?\n  \}, \[\]\)/,
  )?.[0] || ''
  const strictSceneIndex = restoreSource.indexOf('sceneReconcileRef.current(projectId)')
  const refreshIndex = restoreSource.indexOf('setSceneVersion((value) => value + 1)')
  assert.ok(strictSceneIndex >= 0, '终态恢复包含严格情节对账')
  assert.ok(refreshIndex > strictSceneIndex, '严格情节对账成功后才触发普通情节刷新')
  assert.match(
    restoreSource,
    /if \(sceneOk === false\) \{\s*throw new Error/,
    '严格情节读取被抢占时必须进入可重试失败，不能静默卡在生成中',
  )
}

assert.match(panelSource, /onViewChange/, '情节面板向情境提示上报真实视图')
assert.match(panelSource, /if \(selected && scene\) \{/, '只有情节读取成功并画出 SceneForm 才上报 scene')
assert.match(panelSource, /reportView\(\{ kind: 'list', eventId: null \}\)/, '列表、返回和读取失败保持 list')
assert.match(panelSource, /onBack=\{\(\) => \{[\s\S]*reportView\(\{ kind: 'list'/, '返回列表时恢复 list')
assert.match(panelSource, /onInspectorChange/, '情节检查器打开、关闭和返回时上报')
assert.match(panelSource, /eventId: selected/, '情节检查器上报补上当前事件 id')
assert.match(panelSource, /onSaveComplete/, '情节保存成功后上报，供尚未检测提示绑定视图')
assert.match(panelSource, /if \(!visible\)/, '事件列表页不可见时不得继续贡献情节检查器')
assert.match(panelSource, /onBack=\{\(\) => \{[\s\S]*onInspectorChange\?\.\(null\)/, '返回列表时清空情节检查器')

assert.match(formSource, /kind: 'scene-beat'/, '情节节点检查器上报 scene-beat')
assert.match(formSource, /kind: 'scene-edge'/, '情节边检查器上报 scene-edge')
assert.match(formSource, /onInspectorChange\?\.\(null\)/, '关闭或删除后清空情节检查器')

assert.match(panelSource, /applyPreviewBundle/, '检查点 bundle 一次写入情节 last-good')

{
  const controller = createSceneResourceController({
    listScenes: async () => ({ scenes: [] }),
    getScene: async () => {
      throw new Error('正式 GET 不应在预览代次被调用')
    },
  })
  controller.applyPreviewBundle('p1', {
    scene_overview: [{ event_id: 'A', has_scene: true }],
    scenes: { A: { event_id: 'A', beats: [{ id: 'b1' }], edges: [] } },
    targets: [{ data_type: 'scenes', event_id: 'A', deleted: false }],
  })
  const snap = controller.snapshot()
  assert.equal(snap.overview[0].event_id, 'A', '预览总览一次写入')
  assert.equal(snap.scenes.A.content.beats[0].id, 'b1', '预览情节正文一次写入')
}

console.log('scene_network_recovery_check: all assertions passed')
