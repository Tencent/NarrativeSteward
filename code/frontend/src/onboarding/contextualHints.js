import { getConcept } from './concepts.js';
const INSPECTOR_HINT_IDS = Object.freeze({
  'world-card': 'firstWorldCardInspector',
  'event-node': 'firstEventNodeInspector',
  'event-edge': 'firstEventEdgeInspector',
  'scene-beat': 'firstSceneBeatInspector',
  'scene-edge': 'firstSceneEdgeInspector',
  variable: 'firstVariableInspector'
});
export const CONTEXTUAL_HINTS = Object.freeze([{
  id: 'firstWorldCardInspector',
  conceptId: 'worldCard',
  tier: 'inspector'
}, {
  id: 'firstEventNodeInspector',
  conceptId: 'event',
  tier: 'inspector'
}, {
  id: 'firstEventEdgeInspector',
  conceptId: 'choice',
  tier: 'inspector'
}, {
  id: 'firstSceneBeatInspector',
  conceptId: 'beat',
  tier: 'inspector'
}, {
  id: 'firstSceneEdgeInspector',
  conceptId: 'choice',
  tier: 'inspector'
}, {
  id: 'firstVariableInspector',
  conceptId: 'stateVariable',
  tier: 'inspector'
}, {
  id: 'firstEmptyProjectAgent',
  conceptId: 'agent',
  tier: 'page'
}, {
  id: 'firstMaterials',
  conceptId: 'materials',
  tier: 'page'
}, {
  id: 'firstIntent',
  conceptId: 'intent',
  tier: 'page'
}, {
  id: 'firstOutline',
  conceptId: 'outline',
  tier: 'page'
}, {
  id: 'firstWorld',
  conceptId: 'worldCard',
  tier: 'page'
}, {
  id: 'firstEventNetwork',
  conceptId: 'eventNetwork',
  tier: 'page'
}, {
  id: 'firstEventList',
  conceptId: 'eventList',
  tier: 'page'
}, {
  id: 'firstSceneNetwork',
  conceptId: 'sceneNetwork',
  tier: 'page'
}, {
  id: 'firstVariables',
  conceptId: 'stateVariable',
  tier: 'page'
}, {
  id: 'firstValidation',
  conceptId: 'validation',
  tier: 'page'
}, {
  id: 'firstPlaytest',
  conceptId: 'playtest',
  tier: 'page'
}, {
  id: 'firstChangesetLocate',
  conceptId: 'agentChangeset',
  tier: 'operation'
}, {
  id: 'firstChangeset',
  conceptId: 'agentChangeset',
  tier: 'operation'
}, {
  id: 'firstLockedChoice',
  conceptId: 'unlockCondition',
  tier: 'operation'
}, {
  id: 'firstSaveUnchecked',
  conceptId: 'validationStatuses',
  tier: 'operation'
}]);
const HINT_BY_ID = new Map(CONTEXTUAL_HINTS.map(hint => [hint.id, hint]));
function onBuildTab(context, tab) {
  return context.board === 'build' && context.activeTab === tab;
}
function onEventsListView(context, subtab) {
  return onBuildTab(context, 'events') && context.eventsSubtab === subtab && context.sceneView !== 'scene';
}
export function getContextualHint(hintId) {
  return HINT_BY_ID.get(hintId) || null;
}
function firstUnusedHint(hintIds, seen) {
  for (const id of hintIds) {
    const hint = HINT_BY_ID.get(id);
    if (hint && !seen[id] && getConcept(hint.conceptId)) return hint;
  }
  return null;
}
function matchInspectorHintId(context) {
  return INSPECTOR_HINT_IDS[context.inspectorFocus?.kind] || null;
}
function matchPageHintIds(context) {
  const ids = [];
  if (context.newlyCreatedEmptyProject) ids.push('firstEmptyProjectAgent');
  if (onBuildTab(context, 'materials') && !context.newlyCreatedEmptyProject) {
    ids.push('firstMaterials');
  }
  if (onBuildTab(context, 'intent')) ids.push('firstIntent');
  if (onBuildTab(context, 'outline')) ids.push('firstOutline');
  if (onBuildTab(context, 'world')) ids.push('firstWorld');
  if (onEventsListView(context, 'network')) ids.push('firstEventNetwork');
  if (onEventsListView(context, 'content')) ids.push('firstEventList');
  if (onBuildTab(context, 'events') && context.sceneView === 'scene') {
    ids.push('firstSceneNetwork');
  }
  if (onEventsListView(context, 'variables')) ids.push('firstVariables');
  if (onEventsListView(context, 'validation')) ids.push('firstValidation');
  if (context.board === 'playtest') ids.push('firstPlaytest');
  return ids;
}
function matchChangesetHintIds(context) {
  const ids = [];
  if (context.changesetDetailsOpen) ids.push('firstChangesetLocate');
  if (context.hasChangeset) ids.push('firstChangeset');
  return ids;
}
function matchOperationHintIds(context) {
  const ids = [];
  const pageViewKey = context.pageViewKey || context.viewKey || '';
  if (context.hasLockedChoice && context.board === 'playtest') {
    ids.push('firstLockedChoice');
  }
  if (context.pendingSaveViewKey && context.pendingSaveViewKey === pageViewKey && context.validationStatus === 'not_checked') {
    ids.push('firstSaveUnchecked');
  }
  return ids;
}
export function pickContextualHint(context = {}) {
  if (!context.hasProject || context.quickStartOpen || context.isDemo || context.projectSwitching || context.conceptHelpOpen) {
    return null;
  }
  const seen = context.seen || {};
  const inspectorId = matchInspectorHintId(context);
  if (inspectorId) {
    const inspectorHint = firstUnusedHint([inspectorId], seen);
    if (inspectorHint) return inspectorHint;
  }
  const changesetHint = firstUnusedHint(matchChangesetHintIds(context), seen);
  if (changesetHint) return changesetHint;
  const pageHint = firstUnusedHint(matchPageHintIds(context), seen);
  if (pageHint) return pageHint;
  return firstUnusedHint(matchOperationHintIds(context), seen);
}
