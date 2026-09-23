export function captureQuickStartReturnContext(state) {
  const demoId = state?.demoProjectId || null;
  const selectedId = state?.selectedId && state.selectedId !== demoId ? state.selectedId : null;
  return {
    selectedId,
    board: state?.board || 'build',
    activeTab: state?.activeTab || 'materials',
    eventsSubtab: state?.eventsSubtab || 'network',
    sceneOpen: {
      id: state?.sceneOpen?.id || null,
      focusKind: state?.sceneOpen?.focusKind || null,
      focusId: state?.sceneOpen?.focusId || null
    },
    eventFocus: {
      kind: state?.eventFocus?.kind || null,
      id: state?.eventFocus?.id || null
    },
    worldFocus: {
      objectType: state?.worldFocus?.objectType || null,
      objectId: state?.worldFocus?.objectId || null
    },
    sidebarCollapsed: Boolean(state?.sidebarCollapsed),
    chatCollapsed: Boolean(state?.chatCollapsed)
  };
}
export function applyQuickStartViewSnapshot(snapshot, setters) {
  if (!snapshot) return;
  setters.setBoard(snapshot.board);
  setters.setActiveTab(snapshot.activeTab);
  setters.setEventsSubtab(snapshot.eventsSubtab);
  setters.setSceneOpen(prev => ({
    id: snapshot.sceneOpen.id,
    focusKind: snapshot.sceneOpen.focusKind,
    focusId: snapshot.sceneOpen.focusId,
    seq: (prev?.seq || 0) + 1
  }));
  setters.setEventFocus(prev => ({
    kind: snapshot.eventFocus.kind,
    id: snapshot.eventFocus.id,
    seq: (prev?.seq || 0) + 1
  }));
  setters.setWorldFocus(prev => ({
    objectType: snapshot.worldFocus.objectType,
    objectId: snapshot.worldFocus.objectId,
    seq: (prev?.seq || 0) + 1
  }));
  setters.setSidebarCollapsed(snapshot.sidebarCollapsed);
  setters.setChatCollapsed(snapshot.chatCollapsed);
}
