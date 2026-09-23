import assert from 'node:assert/strict'
import { applyQuickStartViewSnapshot, captureQuickStartReturnContext } from '../src/onboarding/quickStartReturn.js'
const snapshot = captureQuickStartReturnContext({
  selectedId: 'project-1', demoProjectId: 'demo-1', board: 'playtest',
  activeTab: 'events', eventsSubtab: 'list',
  sceneOpen: { id: 'ev-1', focusKind: 'beat', focusId: 'beat-1' },
  eventFocus: { kind: 'node', id: 'ev-1' },
  worldFocus: { objectType: 'character', objectId: 'ch-1' },
  sidebarCollapsed: true, chatCollapsed: true,
})
assert.equal(snapshot.selectedId, 'project-1')
const restored = {}, setters = {}
for (const key of ['board', 'activeTab', 'eventsSubtab', 'sceneOpen', 'eventFocus', 'worldFocus', 'sidebarCollapsed', 'chatCollapsed']) {
  setters[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
    restored[key] = typeof value === 'function' ? value({ seq: 7 }) : value
  }
}
applyQuickStartViewSnapshot(snapshot, setters)
for (const key of ['board', 'activeTab', 'eventsSubtab', 'sidebarCollapsed', 'chatCollapsed']) assert.equal(restored[key], snapshot[key])
for (const key of ['sceneOpen', 'eventFocus', 'worldFocus']) assert.deepEqual(restored[key], { ...snapshot[key], seq: 8 })
assert.equal(captureQuickStartReturnContext({ selectedId: 'demo-1', demoProjectId: 'demo-1' }).selectedId, null)
assert.equal(captureQuickStartReturnContext({}).selectedId, null)
assert.equal(captureQuickStartReturnContext({}).board, 'build')
applyQuickStartViewSnapshot(null, {})
console.log('quick_start_return_check: project, focus, panels and empty return pass')
