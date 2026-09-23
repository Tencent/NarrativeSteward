import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useProjectEvents } from './hooks/useProjectEvents';
import { useAgentTurnReconciliation, isTerminalChatRunStatus } from './hooks/useAgentTurnReconciliation';
import { classifyProcessEvent, classifyTurnEvent, createTerminalTurnSettlement, shouldAcceptPreview, shouldBindUnknownTurnStart, TURN_START_BIND_TIMEOUT_MS, turnSettlementKey } from './turnSettlement';
import { applyTraceEvent, hasBlockingDraft, isDuplicateTraceEvent, shouldDisplayStatusNote } from './hooks/useExecutionTrace';
import { applyPreviewLoadResult, combinedPreviewStatus, createGenerationPreviewController, createPreviewRetryController, createRefreshCoordinator, eventStagePreviewKeys, previewBannerMessage, previewBundleRetryKey, PREVIEW_STATUS, refreshKey, shouldSkipDirtyPreview } from './hooks/useProjectRefresh';
import { changeNavigation } from './changePresentation';
import { validationLocation } from './validationLocation';
import Sidebar from './components/Sidebar';
import StageTabs from './components/StageTabs';
import MaterialsPanel from './components/MaterialsPanel';
import IntentCard from './components/IntentCard';
import WorldForm from './components/WorldForm';
import OutlineEditor from './components/OutlineEditor';
import EventForm from './components/EventForm';
import ScenePanel from './components/ScenePanel';
import PlaytestPanel from './components/PlaytestPanel';
import PlayabilityCheck from './components/PlayabilityCheck';
import ChatPanel from './components/ChatPanel';
import { CHAT_PANEL_DEFAULT_WIDTH, CHAT_WIDTH_STORAGE_KEY, clampDisplayedChatWidth, clampPreferredChatWidth, chatPanelWidthBounds, parseStoredChatWidth } from './chatPanelSizing';
import { productNameForMode } from './branding';
import ConceptHelpPanel from './components/ConceptHelpPanel';
import { ConceptHelpButton, ConceptHelpProvider } from './components/ConceptHelpContext';
import Modal from './components/Modal';
import QuickStartOverlay from './components/QuickStartOverlay';
import ContextualHint from './components/ContextualHint';
import ProjectOperationStatus from './components/ProjectOperationStatus';
import { pickContextualHint } from './onboarding/contextualHints';
import { buildPageViewKey, buildViewKey, resolveVisibleInspector } from './onboarding/contextualView';
import { clearQuickStartStepId, markHintSeen, readQuickStartCompleted, readSeenHints, writeQuickStartCompleted } from './onboarding/hintStorage';
import { applyQuickStartViewSnapshot, captureQuickStartReturnContext } from './onboarding/quickStartReturn';
import { buildPlaytestRequestPayload, inferPlaytestPhase, playtestContextChip, shouldAttachPlaytestContext } from './playtestContext';
import { playtestContentVersionKey } from './playtestSessionPolicy';
import { playtestGuideTarget, playtestPanelKey } from './playtestGuide';
import { formatAssetOperationBusyReason } from './assetOperation';
import { LocaleSwitch, useLocale } from './i18n';
const DATA_TYPES = ['intent', 'outline', 'world', 'events'];
const SIDEBAR_COLLAPSED_KEY = 'gflow.layout.sidebarCollapsed';
const CHAT_COLLAPSED_KEY = 'gflow.layout.chatCollapsed';
document.title = productNameForMode('normal');
const STAGE_TAB_IDS = ['materials', 'intent', 'outline', 'world', 'events'];
const VALIDATION_STATUS_KEYS = {
  not_checked: 'workspace.validationCompact.not_checked',
  incomplete: 'workspace.validationCompact.incomplete',
  failed: 'workspace.validationCompact.failed',
  passed: 'workspace.validationCompact.passed'
};
const VALIDATION_STATUS_ICONS = {
  not_checked: '●',
  incomplete: '▲',
  failed: '✕',
  running: '…'
};
function useStoredBoolean(key, defaultValue = false) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? defaultValue : stored === 'true';
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}
function useStoredNumber(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const parsed = parseStoredChatWidth(window.localStorage.getItem(key));
      return parsed == null ? defaultValue : clampPreferredChatWidth(parsed);
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}
function PreviewBanner({
  status
}) {
  const {
    t
  } = useLocale();
  const text = previewBannerMessage(status, t);
  if (!text) return null;
  return <div className="preview-banner">{text}</div>;
}
export default function App() {
  const {
    t,
    locale
  } = useLocale();
  const stageTabs = STAGE_TAB_IDS.map((id) => ({
    id,
    label: t(`workspace.tabs.${id}`)
  }));
  const [conceptHelpOpen, setConceptHelpOpen] = useState(false);
  const [conceptHelpId, setConceptHelpId] = useState(null);
  const [createdEmptyProjectId, setCreatedEmptyProjectId] = useState(null);
  const [sceneView, setSceneView] = useState('list');
  const [inspectorReports, setInspectorReports] = useState({
    world: null,
    event: null,
    scene: null
  });
  const [pendingSaveViewKey, setPendingSaveViewKey] = useState(null);
  const [changesetDetailsOpen, setChangesetDetailsOpen] = useState(false);
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [demoProjectId, setDemoProjectId] = useState(null);
  const [activeHint, setActiveHint] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [project, setProject] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [fragments, setFragments] = useState({});
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [turnPhase, setTurnPhase] = useState('idle');
  const [currentTurnId, setCurrentTurnId] = useState(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [chatStartPending, setChatStartPending] = useState(false);
  const [chatStartTimedOut, setChatStartTimedOut] = useState(false);
  const [settlingTurnKey, setSettlingTurnKey] = useState(null);
  const [settlementRetry, setSettlementRetry] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [board, setBoard] = useState('build');
  const [playtestSnapshot, setPlaytestSnapshot] = useState(null);
  const [playtestFocusEdgeId, setPlaytestFocusEdgeId] = useState(null);
  const playtestSnapshotRef = useRef(null);
  const playtestSnapshotProjectRef = useRef(null);
  const [activeTab, setActiveTab] = useState('materials');
  const [eventsSubtab, setEventsSubtab] = useState('network');
  const [sceneVersion, setSceneVersion] = useState(0);
  const [validationVersion, setValidationVersion] = useState(0);
  const [sceneOpen, setSceneOpen] = useState({
    id: null,
    focusKind: null,
    focusId: null,
    seq: 0
  });
  const [eventFocus, setEventFocus] = useState({
    kind: null,
    id: null,
    seq: 0
  });
  const [worldFocus, setWorldFocus] = useState({
    objectType: null,
    objectId: null,
    seq: 0
  });
  const [quickStartPlaytestSeq, setQuickStartPlaytestSeq] = useState(0);
  const [quickStartPlaytestTarget, setQuickStartPlaytestTarget] = useState(null);
  const [quickStartStepId, setQuickStartStepId] = useState(null);
  const [reachability, setReachability] = useState([]);
  const [streamId, setStreamId] = useState(null);
  const [dirtyMap, setDirtyMap] = useState({});
  const [previewKeys, setPreviewKeys] = useState({});
  const [scenePreview, setScenePreview] = useState({
    eventId: null,
    seq: 0,
    bundle: null
  });
  const [worldPreviewAsset, setWorldPreviewAsset] = useState(null);
  const traceSeenRef = useRef(new Set());
  const selectedIdRef = useRef(null);
  const turnPhaseRef = useRef('idle');
  const projectLoadGenRef = useRef(0);
  const turnEpochRef = useRef(0);
  const settlementCtlRef = useRef(null);
  if (!settlementCtlRef.current) settlementCtlRef.current = createTerminalTurnSettlement();
  const currentTurnIdRef = useRef(null);
  const chatStartPendingRef = useRef(false);
  const sceneReconcileRef = useRef(null);
  const refreshCoordinatorRef = useRef(null);
  if (!refreshCoordinatorRef.current) refreshCoordinatorRef.current = createRefreshCoordinator();
  const previewRetryRef = useRef(null);
  if (!previewRetryRef.current) previewRetryRef.current = createPreviewRetryController();
  const generationPreviewRef = useRef(null);
  if (!generationPreviewRef.current) generationPreviewRef.current = createGenerationPreviewController();
  const previewFailureCountRef = useRef({});
  const applyPreviewResultRef = useRef(null);
  const pendingPreviewRef = useRef(null);
  const previewRequestTokenRef = useRef(0);
  const pageViewKeyRef = useRef('');
  selectedIdRef.current = selectedId;
  turnPhaseRef.current = turnPhase;
  currentTurnIdRef.current = currentTurnId;
  chatStartPendingRef.current = chatStartPending;
  useEffect(() => () => {
    previewRetryRef.current.cancel();
    generationPreviewRef.current.cancel();
  }, []);
  const quickStartReturnRef = useRef(null);
  const workspaceViewRef = useRef(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useStoredBoolean(SIDEBAR_COLLAPSED_KEY);
  const [chatCollapsed, setChatCollapsed] = useStoredBoolean(CHAT_COLLAPSED_KEY);
  const [chatWidth, setChatWidth] = useStoredNumber(CHAT_WIDTH_STORAGE_KEY, CHAT_PANEL_DEFAULT_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1920 : window.innerWidth);
  const [tourChatCollapsed, setTourChatCollapsed] = useState(null);
  const [tourChangesetExpanded, setTourChangesetExpanded] = useState(null);
  const [assetOperation, setAssetOperation] = useState(null);
  const assetOperationRef = useRef(null);
  const hasUnsavedChanges = Object.values(dirtyMap).some(Boolean);
  const isDemoProject = Boolean(demoProjectId && selectedId === demoProjectId);
  workspaceViewRef.current = {
    selectedId,
    demoProjectId,
    board,
    activeTab,
    eventsSubtab,
    sceneOpen,
    eventFocus,
    worldFocus,
    sidebarCollapsed,
    chatCollapsed
  };
  const captureQuickStartReturnIfNeeded = useCallback(() => {
    if (quickStartReturnRef.current) return;
    quickStartReturnRef.current = captureQuickStartReturnContext(workspaceViewRef.current);
  }, []);
  const agentTurnActive = turnPhase === 'running' || turnPhase === 'stop_requested' || turnPhase === 'completing' || turnPhase === 'stopped' || Boolean(settlingTurnKey);
  const contentReadOnly = busy || validationBusy || Boolean(assetOperation) || isDemoProject || Boolean(settlingTurnKey) || projectSwitching;
  const readOnly = contentReadOnly;
  const assetBusyReason = formatAssetOperationBusyReason(assetOperation, t);
  const playtestUnavailable = validationBusy;
  const playtestContentKey = playtestContentVersionKey(project);
  const chatPanelCollapsed = tourChatCollapsed === null ? chatCollapsed : tourChatCollapsed;
  const chatWidthLayout = {
    viewportWidth,
    sidebarCollapsed
  };
  const chatWidthBounds = chatPanelWidthBounds(chatWidthLayout);
  const displayedChatWidth = clampDisplayedChatWidth(chatWidth, chatWidthLayout);
  const updateChatWidth = useCallback((nextWidth) => {
    setChatWidth(clampPreferredChatWidth(nextWidth));
  }, []);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const playtestTabTitle = playtestUnavailable ? t('workspace.board.playtestUnavailableValidation') : t('workspace.board.playtestAvailable');
  const handleTabChange = useCallback((nextTab) => {
    if (nextTab === activeTab) return;
    setActiveTab(nextTab);
  }, [activeTab]);
  const handleBoardChange = useCallback((nextBoard) => {
    if (nextBoard === board) return;
    setBoard(nextBoard);
  }, [board]);
  const handlePlaytestContextChange = useCallback((snapshot) => {
    playtestSnapshotRef.current = snapshot;
    setPlaytestSnapshot(snapshot);
    const nextIds = snapshot?.citableEdgeIds || [];
    setPlaytestFocusEdgeId((current) => current && nextIds.includes(current) ? current : null);
  }, []);
  const handleCitePlaytestChoice = useCallback((choice) => {
    const edgeId = choice?.edge?.id;
    if (!edgeId) return;
    setPlaytestFocusEdgeId(edgeId);
    setChatCollapsed(false);
  }, []);
  if (playtestSnapshotProjectRef.current !== selectedId) {
    playtestSnapshotProjectRef.current = selectedId;
    playtestSnapshotRef.current = null;
  }
  useEffect(() => {
    setPlaytestFocusEdgeId(null);
    setSceneView('list');
    setInspectorReports({
      world: null,
      event: null,
      scene: null
    });
    setPendingSaveViewKey(null);
    setChangesetDetailsOpen(false);
    if (!selectedId) setPlaytestSnapshot(null);
  }, [selectedId]);
  useEffect(() => {
    if (createdEmptyProjectId && selectedId !== createdEmptyProjectId) {
      setCreatedEmptyProjectId(null);
    }
  }, [selectedId, createdEmptyProjectId]);
  const refreshProjects = useCallback(async () => {
    const {
      projects
    } = await api.listProjects();
    setProjects(projects);
  }, []);
  const loadProject = useCallback(async (id, {
    applyBusy = true
  } = {}) => {
    const p = await api.getProject(id);
    if (selectedIdRef.current !== id) return p;
    setProject(p);
    if (applyBusy) setBusy(p.busy);
    return p;
  }, []);
  const fragmentRequestSeq = useRef({});
  const loadFragment = useCallback(async (id, type) => {
    const seq = (fragmentRequestSeq.current[type] || 0) + 1;
    fragmentRequestSeq.current[type] = seq;
    try {
      const frag = await api.getData(id, type);
      if (fragmentRequestSeq.current[type] !== seq || selectedIdRef.current !== id) return 'stale';
      setFragments((prev) => ({
        ...prev,
        [type]: frag
      }));
      return 'applied';
    } catch {
      if (fragmentRequestSeq.current[type] !== seq || selectedIdRef.current !== id) return 'stale';
      return 'failed';
    }
  }, []);
  const clearPreviewState = useCallback((key) => {
    if (key) {
      previewRetryRef.current.cancel(key);
      delete previewFailureCountRef.current[key];
      setPreviewKeys((prev) => {
        if (!prev[key]) return prev;
        const next = {
          ...prev
        };
        delete next[key];
        return next;
      });
      return;
    }
    previewRetryRef.current.cancel();
    generationPreviewRef.current.cancel();
    previewFailureCountRef.current = {};
    pendingPreviewRef.current = null;
    setPreviewKeys({});
    setScenePreview({
      eventId: null,
      seq: 0,
      bundle: null
    });
    setWorldPreviewAsset(null);
  }, []);
  const applyPreviewResult = useCallback(async (payload, options = {}) => {
    const isRetry = Boolean(options.isRetry);
    const projectId = selectedIdRef.current;
    const turnId = payload.turn_id;
    const generation = payload.preview_generation;
    if (!projectId || !turnId || generation == null) return;
    if (generationPreviewRef.current.isRevoked(turnId, generation)) return;
    const bundleKey = previewBundleRetryKey(projectId, turnId, generation);
    let token;
    if (isRetry) {
      token = previewRequestTokenRef.current;
      if (!generationPreviewRef.current.isCurrent(projectId, turnId, generation, token)) return;
    } else {
      previewRetryRef.current.cancel();
      previewRetryRef.current.begin(bundleKey);
      delete previewFailureCountRef.current[bundleKey];
      token = generationPreviewRef.current.begin(projectId, turnId, generation);
      previewRequestTokenRef.current = token;
    }
    const targets = payload.targets || [];
    const keys = targets.map((target) => refreshKey(target.data_type, target.event_id));
    setPreviewKeys((prev) => {
      const next = {
        ...prev
      };
      for (const key of keys) next[key] = isRetry ? PREVIEW_STATUS.retrying : PREVIEW_STATUS.loading;
      return next;
    });
    try {
      const bundle = await api.getTurnPreview(projectId, turnId, generation);
      if (!generationPreviewRef.current.isCurrent(projectId, turnId, generation, token) || generationPreviewRef.current.isRevoked(turnId, generation) || selectedIdRef.current !== projectId) {
        return;
      }
      previewRetryRef.current.cancel(bundleKey);
      delete previewFailureCountRef.current[bundleKey];
      setFragments((prev) => {
        const next = {
          ...prev
        };
        for (const [type, content] of Object.entries(bundle.fragments || {})) {
          if (shouldSkipDirtyPreview(dirtyMap, type)) continue;
          const previous = prev[type] || {};
          next[type] = {
            ...previous,
            data_type: type,
            content
          };
        }
        return next;
      });
      setScenePreview({
        eventId: targets.find((item) => item.data_type === 'scenes')?.event_id || null,
        seq: Date.now(),
        bundle
      });
      if (bundle.fragments?.world) {
        setWorldPreviewAsset({
          projectId,
          turnId,
          generation
        });
      }
      if (bundle.fragments?.events || targets.some((item) => item.data_type === 'events' || item.data_type === 'scenes')) {
        setSceneVersion((value) => value + 1);
      }
      setPreviewKeys((prev) => {
        const next = {
          ...prev
        };
        for (const key of keys) next[key] = PREVIEW_STATUS.ready;
        return next;
      });
    } catch {
      if (!generationPreviewRef.current.isCurrent(projectId, turnId, generation, token) || generationPreviewRef.current.isRevoked(turnId, generation) || selectedIdRef.current !== projectId) {
        applyPreviewLoadResult('stale', previewFailureCountRef.current[bundleKey] || 0);
        return;
      }
      const outcome = applyPreviewLoadResult('failed', previewFailureCountRef.current[bundleKey] || 0);
      previewFailureCountRef.current[bundleKey] = outcome.failureCount;
      setPreviewKeys((prev) => {
        const next = {
          ...prev
        };
        for (const key of keys) next[key] = outcome.status;
        return next;
      });
      if (outcome.retry) {
        previewRetryRef.current.schedule(bundleKey, () => {
          applyPreviewResultRef.current?.(payload, {
            isRetry: true
          });
        });
      }
    }
  }, [dirtyMap]);
  applyPreviewResultRef.current = applyPreviewResult;
  const loadMaterials = useCallback(async (id) => {
    const {
      materials
    } = await api.listMaterials(id);
    if (selectedIdRef.current !== id) return;
    setMaterials(materials || []);
  }, []);
  const loadReachability = useCallback(async (id) => {
    try {
      const {
        warnings
      } = await api.getReachability(id);
      if (selectedIdRef.current !== id) return;
      setReachability(warnings || []);
    } catch {
      if (selectedIdRef.current !== id) return;
      setReachability([]);
    }
  }, []);
  const applyActiveRun = useCallback((run) => {
    if (run?.turn_id) {
      setCurrentTurnId(run.turn_id);
      chatStartPendingRef.current = false;
      setChatStartPending(false);
      setChatStartTimedOut(false);
      const pending = pendingPreviewRef.current;
      if (pending && pending.epoch === turnEpochRef.current && pending.payload?.turn_id === run.turn_id) {
        pendingPreviewRef.current = null;
        applyPreviewResultRef.current?.(pending.payload);
      } else if (pending && pending.payload?.turn_id !== run.turn_id) {
        pendingPreviewRef.current = null;
      }
    }
    if (run?.status === 'running') {
      setTurnPhase('running');
      setBusy(true);
    } else if (run?.status === 'stop_requested') {
      setTurnPhase('stop_requested');
      setBusy(true);
    } else if (run?.status === 'completing') {
      setTurnPhase('completing');
      setBusy(true);
    }
  }, []);
  const loadCanonicalWorkspace = useCallback(async ({
    projectId,
    gen,
    epoch
  }) => {
    const stale = () => projectLoadGenRef.current !== gen || turnEpochRef.current !== epoch || selectedIdRef.current !== projectId;
    const {
      messages: history
    } = await api.getHistory(projectId);
    if (stale()) return false;
    const [projectMeta, fragmentEntries, reachabilityPayload] = await Promise.all([api.getProject(projectId), Promise.all(DATA_TYPES.map(async (type) => [type, await api.getData(projectId, type)])), api.getReachability(projectId).catch(() => ({
      warnings: []
    }))]);
    if (stale()) return false;
    for (const type of DATA_TYPES) {
      fragmentRequestSeq.current[type] = (fragmentRequestSeq.current[type] || 0) + 1;
    }
    setMessages(history || []);
    setProject(projectMeta);
    setFragments((previous) => {
      const next = {
        ...previous
      };
      for (const [type, frag] of fragmentEntries) next[type] = frag;
      return next;
    });
    setReachability(reachabilityPayload.warnings || []);
    setValidationVersion((value) => value + 1);
    if (typeof sceneReconcileRef.current === 'function') {
      const sceneOk = await sceneReconcileRef.current(projectId);
      if (sceneOk === false) {
        throw new Error('情节终态对账被更新的请求取代');
      }
    } else {
      await api.listScenes(projectId);
    }
    if (stale()) return false;
    setSceneVersion((value) => value + 1);
    return true;
  }, []);
  const restoreSettledTurn = useCallback(async (run = {}) => {
    const projectId = selectedIdRef.current;
    const gen = projectLoadGenRef.current;
    const epoch = turnEpochRef.current;
    const turnId = run?.turn_id || currentTurnIdRef.current;
    const stale = () => projectLoadGenRef.current !== gen || turnEpochRef.current !== epoch || selectedIdRef.current !== projectId;
    const settlementKey = turnSettlementKey(projectId, turnId);
    try {
      const result = await settlementCtlRef.current.restore({
        projectId,
        turnId,
        status: run?.status,
        loadAndApply: async () => {
          if (run?.turn_id) setCurrentTurnId(run.turn_id);
          setSettlingTurnKey(settlementKey);
          refreshCoordinatorRef.current.cancel();
          refreshCoordinatorRef.current.flush();
          clearPreviewState();
          setStopBusy(false);
          setBusy(true);
          setTurnPhase((phase) => phase === 'stop_requested' || phase === 'stopped' ? 'stopped' : phase);
          if (stale()) return false;
          const applied = await loadCanonicalWorkspace({
            projectId,
            gen,
            epoch
          });
          if (!applied) return false;
          setSettlementRetry(false);
          setTurnPhase('idle');
          setBusy(false);
          setStopBusy(false);
          return true;
        }
      });
      if (result.action === 'skip-anonymous') return false;
      if (result.action === 'start') return result.applied === true;
      return true;
    } catch (err) {
      if (stale()) return;
      setSettlementRetry(true);
      if (turnPhaseRef.current === 'stop_requested' || turnPhaseRef.current === 'stopped') {
        setTurnPhase('stop_requested');
      }
      setBusy(true);
      throw err;
    } finally {
      if (!settlementCtlRef.current.snapshot().settlingKey) {
        setSettlingTurnKey((current) => current === settlementKey ? null : current);
      }
    }
  }, [clearPreviewState, loadCanonicalWorkspace]);
  const recoverOrphanedTurn = useCallback(async () => {
    const projectId = selectedIdRef.current;
    chatStartPendingRef.current = false;
    setChatStartPending(false);
    setChatStartTimedOut(false);
    turnEpochRef.current += 1;
    const epoch = turnEpochRef.current;
    const gen = projectLoadGenRef.current;
    settlementCtlRef.current.beginNewTurn();
    setSettlingTurnKey(null);
    setSettlementRetry(false);
    setCurrentTurnId(null);
    setTurnPhase('idle');
    setBusy(false);
    setStopBusy(false);
    refreshCoordinatorRef.current.cancel();
    refreshCoordinatorRef.current.flush();
    clearPreviewState();
    if (!projectId) return;
    try {
      await loadCanonicalWorkspace({
        projectId,
        gen,
        epoch
      });
    } catch {}
  }, [clearPreviewState, loadCanonicalWorkspace]);
  const handleAssetOperationChange = useCallback((next) => {
    const normalized = next && next.projectId === selectedIdRef.current ? next : null;
    assetOperationRef.current = normalized;
    setAssetOperation(normalized);
  }, []);
  const selectProject = useCallback(async (id) => {
    if (assetOperationRef.current && id !== selectedIdRef.current) {
      setBanner(t('workspace.chrome.assetBusySwitchProject'));
      return;
    }
    const loadGen = projectLoadGenRef.current + 1;
    projectLoadGenRef.current = loadGen;
    setProjectSwitching(true);
    setConceptHelpOpen(false);
    try {
      const projectMeta = await api.getProject(id);
      if (projectLoadGenRef.current !== loadGen) return;
      const [materialsPayload, fragmentEntries, historyPayload] = await Promise.all([api.listMaterials(id), Promise.all(DATA_TYPES.map(async (type) => [type, await api.getData(id, type)])), api.getHistory(id)]);
      if (projectLoadGenRef.current !== loadGen) return;
      let run = {
        status: 'idle'
      };
      try {
        run = await api.chatRun(id);
      } catch {
        run = {
          status: 'idle'
        };
      }
      const reachabilityPayload = await api.getReachability(id).catch(() => ({
        warnings: []
      }));
      await api.listScenes(id).catch(() => ({
        scenes: []
      }));
      if (projectLoadGenRef.current !== loadGen) return;
      turnEpochRef.current += 1;
      settlementCtlRef.current.beginNewTurn();
      setSettlingTurnKey(null);
      setSettlementRetry(false);
      setChatStartPending(false);
      setChatStartTimedOut(false);
      chatStartPendingRef.current = false;
      setSelectedId(id);
      setStreamId(null);
      setCurrentTurnId(run?.turn_id || null);
      setStopBusy(false);
      fragmentRequestSeq.current = {};
      setFragments(Object.fromEntries(fragmentEntries));
      setProject(projectMeta);
      setBusy(Boolean(projectMeta.busy));
      setMaterials(materialsPayload.materials || []);
      setReachability(reachabilityPayload.warnings || []);
      setMessages(historyPayload.messages || []);
      setValidationBusy(false);
      setValidationVersion((value) => value + 1);
      setSceneVersion((value) => value + 1);
      setDirtyMap({});
      clearPreviewState();
      setActiveTab('materials');
      setEventsSubtab('network');
      setSceneOpen({
        id: null,
        focusKind: null,
        focusId: null,
        seq: 0
      });
      setEventFocus({
        kind: null,
        id: null,
        seq: 0
      });
      setWorldFocus({
        objectType: null,
        objectId: null,
        seq: 0
      });
      setBoard('build');
      if (run.status === 'running' || run.status === 'stop_requested' || run.status === 'completing') {
        applyActiveRun(run);
      } else {
        setTurnPhase('idle');
        if (run?.turn_id && isTerminalChatRunStatus(run.status)) {
          settlementCtlRef.current.markSettled(id, run.turn_id);
        }
      }
      if (projectLoadGenRef.current !== loadGen) return;
      setStreamId(id);
    } catch (err) {
      if (projectLoadGenRef.current !== loadGen) return;
      setBanner(t('workspace.chrome.loadProjectFailed', {
        detail: err.message
      }));
    } finally {
      if (projectLoadGenRef.current === loadGen) setProjectSwitching(false);
    }
  }, [applyActiveRun, clearPreviewState]);
  const openDemoProject = useCallback(async () => {
    const demo = await api.quickStartDemo(locale);
    setDemoProjectId(demo.project_id);
    await selectProject(demo.project_id);
    setActiveTab('materials');
    setEventsSubtab('network');
    setBoard('build');
    return demo.project_id;
  }, [selectProject, locale]);
  const applyQuickStartStep = useCallback((step) => {
    const reveal = step?.reveal;
    setQuickStartStepId(step?.id || null);
    if (!reveal) {
      setTourChatCollapsed(false);
      setTourChangesetExpanded(null);
      return;
    }
    setTourChatCollapsed(reveal.chatPanel === 'collapsed');
    setTourChangesetExpanded(reveal.changesetExpanded || null);
    if (reveal.board) setBoard(reveal.board);
    if (reveal.tab) setActiveTab(reveal.tab);
    if (reveal.eventsSubtab) setEventsSubtab(reveal.eventsSubtab);
    if (Object.prototype.hasOwnProperty.call(reveal, 'openScene') || reveal.sceneBeatId || reveal.sceneEdgeId) {
      setSceneOpen((prev) => ({
        id: Object.prototype.hasOwnProperty.call(reveal, 'openScene') ? reveal.openScene : prev.id,
        focusKind: reveal.sceneEdgeId ? 'edge' : reveal.sceneBeatId ? 'beat' : null,
        focusId: reveal.sceneEdgeId || reveal.sceneBeatId || null,
        seq: prev.seq + 1
      }));
    }
    if (Object.prototype.hasOwnProperty.call(reveal, 'worldType')) {
      setWorldFocus((prev) => ({
        objectType: reveal.worldType,
        objectId: reveal.worldId || null,
        seq: prev.seq + 1
      }));
    }
    if (reveal.variableId) {
      setEventFocus((prev) => ({
        kind: 'variable',
        id: reveal.variableId,
        seq: prev.seq + 1
      }));
    } else if (reveal.eventNodeId || reveal.eventEdgeId) {
      setEventFocus((prev) => ({
        kind: reveal.eventEdgeId ? 'edge' : 'node',
        id: reveal.eventEdgeId || reveal.eventNodeId,
        seq: prev.seq + 1
      }));
    } else if (reveal.eventsSubtab === 'network') {
      setEventFocus((prev) => ({
        kind: null,
        id: null,
        seq: prev.seq + 1
      }));
      setSceneOpen((prev) => ({
        id: null,
        focusKind: null,
        focusId: null,
        seq: prev.seq + 1
      }));
    }
    const guideTarget = playtestGuideTarget(reveal);
    setQuickStartPlaytestTarget(guideTarget);
    if (guideTarget) {
      setQuickStartPlaytestSeq((value) => value + 1);
    }
  }, []);
  useEffect(() => {
    refreshProjects().catch((err) => setBanner(err.message));
  }, [refreshProjects]);
  const patchLastAssistant = (patch) => setMessages((prev) => {
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === 'assistant') {
        next[i] = typeof patch === 'function' ? patch(next[i]) : {
          ...next[i],
          ...patch
        };
        break;
      }
    }
    return next;
  });
  const fetchChatRun = useCallback((id) => api.chatRun(id), []);
  const {
    reconcileNow
  } = useAgentTurnReconciliation({
    projectId: streamId,
    turnPhase,
    expectedTurnId: currentTurnId,
    settlementRetry,
    startPending: chatStartPending,
    startTimedOut: chatStartTimedOut,
    fetchRun: fetchChatRun,
    onActive: applyActiveRun,
    onTerminal: restoreSettledTurn,
    onOrphaned: recoverOrphanedTurn
  });
  useEffect(() => {
    if (!chatStartPending) {
      setChatStartTimedOut(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setChatStartTimedOut(true);
    }, TURN_START_BIND_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [chatStartPending]);
  const applyProcessPayload = (payload, apply) => {
    const kind = classifyProcessEvent({
      eventTurnId: payload?.turn_id,
      currentTurnId: currentTurnIdRef.current
    });
    if (kind === 'stale') return;
    if (kind === 'pending-bind') {
      reconcileNow();
      return;
    }
    apply();
  };
  useProjectEvents(streamId, {
    ready: () => {
      reconcileNow();
    },
    turn_start: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (kind === 'current' && p?.turn_id) {
        setCurrentTurnId(p.turn_id);
      } else if (shouldBindUnknownTurnStart({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current,
        startPending: chatStartPendingRef.current
      })) {
        setCurrentTurnId(p.turn_id);
        chatStartPendingRef.current = false;
        setChatStartPending(false);
        setChatStartTimedOut(false);
      } else if (kind === 'unknown') {
        reconcileNow();
        return;
      }
      setBusy(true);
      setTurnPhase('running');
      refreshCoordinatorRef.current.cancel();
      clearPreviewState();
      traceSeenRef.current = new Set();
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.streaming) return prev;
        return [...prev, {
          role: 'assistant',
          text: '',
          steps: [],
          statusNotes: [],
          streaming: true
        }];
      });
    },
    agent_text: (p) => {
      applyProcessPayload(p, () => {
        if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
        patchLastAssistant((m) => applyTraceEvent(m, 'agent_text', p, t));
      });
    },
    text: (p) => {
      applyProcessPayload(p, () => {
        if (p.agent && p.agent !== 'main-agent') return;
        if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
        patchLastAssistant((m) => ({
          ...m,
          text: (m.text || '') + (p.text || '')
        }));
      });
    },
    tool_start: (p) => {
      applyProcessPayload(p, () => {
        if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
        patchLastAssistant((m) => applyTraceEvent(m, 'tool_start', p, t));
      });
    },
    tool_end: (p) => {
      applyProcessPayload(p, () => {
        if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
        patchLastAssistant((m) => applyTraceEvent(m, 'tool_end', p, t));
      });
    },
    budget_status: (p) => {
      applyProcessPayload(p, () => {
        if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
        patchLastAssistant((m) => applyTraceEvent(m, 'budget_status', p, t));
      });
    },
    status: (p) => {
      applyProcessPayload(p, () => {
        if (!shouldDisplayStatusNote(p)) return;
        patchLastAssistant((m) => applyTraceEvent(m, 'status', p, t));
      });
    },
    data_preview_published: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (kind !== 'current') {
        if (chatStartPendingRef.current && p?.turn_id) {
          pendingPreviewRef.current = {
            epoch: turnEpochRef.current,
            payload: p
          };
        }
        reconcileNow();
        return;
      }
      if (!shouldAcceptPreview(turnPhaseRef.current)) return;
      if (!selectedId) return;
      const blocked = (p.targets || []).every((target) => shouldSkipDirtyPreview(dirtyMap, refreshKey(target.data_type, target.event_id)));
      if (blocked && (p.targets || []).length) return;
      // checkpoint_invalid keeps the last valid graph; only published previews are applied.
      applyPreviewResultRef.current?.(p);
    },
    preview_revoked: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (p?.turn_id && p?.generation != null) {
        generationPreviewRef.current.revoke(p.turn_id, p.generation);
      }
      generationPreviewRef.current.cancel();
      clearPreviewState();
    },
    data_updated: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (kind === 'unknown' && p?.turn_id) {
        reconcileNow();
        return;
      }
      if (!selectedId) return;
      const key = refreshKey(p.data_type, p.event_id);
      previewRetryRef.current.cancel(key);
      delete previewFailureCountRef.current[key];
      setPreviewKeys((prev) => {
        const next = {
          ...prev
        };
        delete next[key];
        if (p.data_type && p.data_type !== 'scenes') delete next[p.data_type];
        return next;
      });
      if (p.data_type === 'scenes') {
        setSceneVersion((v) => v + 1);
      } else {
        loadFragment(selectedId, p.data_type);
      }
      if (p.data_type === 'scenes' || p.data_type === 'events') {
        loadReachability(selectedId);
        setValidationVersion((v) => v + 1);
      }
      loadProject(selectedId);
    },
    agent_changeset_updated: (p) => {
      if (p.changeset) patchChangeset(p.changeset);
    },
    validation_updated: (p) => {
      if (p?.source !== 'agent_commit' && (turnPhaseRef.current === 'running' || turnPhaseRef.current === 'stop_requested' || turnPhaseRef.current === 'completing')) {
        return;
      }
      setValidationVersion((v) => v + 1);
      if (selectedId) {
        loadProject(selectedId);
        loadReachability(selectedId);
      }
    },
    validation_run_updated: (p) => {
      const running = p.status === 'running' || p.status === 'cancelling';
      setBusy(running);
      setValidationBusy(running);
      if (!running) {
        setValidationVersion((v) => v + 1);
        if (selectedId) {
          loadProject(selectedId);
          loadReachability(selectedId);
        }
      }
    },
    turn_completed: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (kind !== 'current') {
        reconcileNow();
        return;
      }
      setTurnPhase('completing');
      patchLastAssistant((m) => applyTraceEvent(m, 'turn_completed', p, t));
      if (selectedId) {
        for (const [dt] of p.updated || []) {
          if (typeof dt === 'string' && dt.startsWith('scene:')) {
            setSceneVersion((v) => v + 1);
            continue;
          }
          loadFragment(selectedId, dt);
        }
      }
    },
    turn_stop_requested: (p) => {
      if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (p?.turn_id) setCurrentTurnId(p.turn_id);
      setTurnPhase('stop_requested');
      setBusy(true);
    },
    turn_stopped: (p) => {
      if (isDuplicateTraceEvent(traceSeenRef.current, p)) return;
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      if (p?.turn_id) setCurrentTurnId(p.turn_id);
      patchLastAssistant((m) => applyTraceEvent(m, 'turn_stopped', p, t));
      reconcileNow();
    },
    turn_end: (p) => {
      const kind = classifyTurnEvent({
        eventTurnId: p?.turn_id,
        currentTurnId: currentTurnIdRef.current
      });
      if (kind === 'stale') return;
      reconcileNow();
    },
    error: (p) => {
      applyProcessPayload(p, () => {
        setMessages((prev) => [...prev, {
          role: 'system',
          text: p.message || '生成失败：未知错误'
        }]);
        patchLastAssistant((m) => ({
          ...m,
          streaming: false
        }));
        reconcileNow();
      });
    }
  });
  const leaveQuickStart = async ({
    restoreSnapshot,
    clearProgress = false
  }) => {
    const snapshot = quickStartReturnRef.current;
    quickStartReturnRef.current = null;
    const progressOwner = null;
    if (clearProgress) clearQuickStartStepId(progressOwner);
    setQuickStartOpen(false);
    setQuickStartPlaytestTarget(null);
    setQuickStartPlaytestSeq(0);
    setQuickStartStepId(null);
    setTourChatCollapsed(null);
    setTourChangesetExpanded(null);
    if (snapshot) {
      setSidebarCollapsed(snapshot.sidebarCollapsed);
      setChatCollapsed(snapshot.chatCollapsed);
    }
    const viewSetters = {
      setBoard,
      setActiveTab,
      setEventsSubtab,
      setSceneOpen,
      setEventFocus,
      setWorldFocus,
      setSidebarCollapsed,
      setChatCollapsed
    };
    if (restoreSnapshot && snapshot?.selectedId) {
      await selectProject(snapshot.selectedId);
      applyQuickStartViewSnapshot(snapshot, viewSetters);
      return;
    }
    setSelectedId(null);
    setProject(null);
    setStreamId(null);
    setMessages([]);
    setFragments({});
    setMaterials([]);
    setReachability([]);
    setDirtyMap({});
    setBoard('build');
    setActiveTab('materials');
    setEventsSubtab('network');
    setSceneOpen({
      id: null,
      focusKind: null,
      focusId: null,
      seq: 0
    });
    setEventFocus({
      kind: null,
      id: null,
      seq: 0
    });
    setWorldFocus({
      objectType: null,
      objectId: null,
      seq: 0
    });
  };
  const completeQuickStart = async () => {
    writeQuickStartCompleted();
    await leaveQuickStart({
      restoreSnapshot: true,
      clearProgress: true
    });
  };
  const openQuickStart = async () => {
    captureQuickStartReturnIfNeeded();
    setSidebarCollapsed(false);
    setChatCollapsed(false);
    try {
      await openDemoProject();
    } catch (error) {
      setBanner(t('workspace.chrome.openDemoFailed', {
        detail: error.message
      }));
    }
    setQuickStartOpen(true);
  };
  const autoOpenedQuickStart = useRef(false);
  useEffect(() => {
    if (readQuickStartCompleted() || autoOpenedQuickStart.current) return;
    autoOpenedQuickStart.current = true;
    let cancelled = false;
    captureQuickStartReturnIfNeeded();
    (async () => {
      try {
        await openDemoProject();
      } catch (error) {
        if (!cancelled) setBanner(t('workspace.chrome.openDemoFailed', {
          detail: error.message
        }));
      }
      if (!cancelled) setQuickStartOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [captureQuickStartReturnIfNeeded, openDemoProject]);
  const compactValidationStatus = validationBusy ? 'running' : project?.validation?.status || 'not_checked';
  const inspectorFocus = useMemo(() => resolveVisibleInspector(inspectorReports, {
    board,
    activeTab,
    eventsSubtab,
    sceneView
  }), [inspectorReports, board, activeTab, eventsSubtab, sceneView]);
  const viewKey = useMemo(() => buildViewKey({
    board,
    activeTab,
    eventsSubtab,
    sceneView,
    inspectorFocus
  }), [board, activeTab, eventsSubtab, sceneView, inspectorFocus]);
  const pageViewKey = useMemo(() => buildPageViewKey({
    board,
    activeTab,
    eventsSubtab,
    sceneView
  }), [board, activeTab, eventsSubtab, sceneView]);
  pageViewKeyRef.current = pageViewKey;
  const handleWorldInspectorChange = useCallback((focus) => {
    setInspectorReports((prev) => ({
      ...prev,
      world: focus
    }));
  }, []);
  const handleEventInspectorChange = useCallback((focus) => {
    setInspectorReports((prev) => ({
      ...prev,
      event: focus
    }));
  }, []);
  const handleSceneInspectorChange = useCallback((focus) => {
    setInspectorReports((prev) => ({
      ...prev,
      scene: focus
    }));
  }, []);
  const recordSaveUncheckedHint = useCallback(() => {
    setPendingSaveViewKey(pageViewKeyRef.current);
  }, []);
  useEffect(() => {
    if (createdEmptyProjectId && (board !== 'build' || activeTab !== 'materials')) {
      setCreatedEmptyProjectId(null);
    }
  }, [board, activeTab, createdEmptyProjectId]);
  useEffect(() => {
    setSceneView('list');
  }, [eventsSubtab]);
  useEffect(() => {
    if (quickStartOpen || isDemoProject || projectSwitching || conceptHelpOpen) {
      setActiveHint(null);
      return;
    }
    const seen = readSeenHints(null);
    const next = pickContextualHint({
      hasProject: Boolean(selectedId),
      quickStartOpen,
      isDemo: isDemoProject,
      projectSwitching,
      conceptHelpOpen,
      seen,
      newlyCreatedEmptyProject: Boolean(createdEmptyProjectId && createdEmptyProjectId === selectedId),
      inspectorFocus,
      viewKey,
      pageViewKey,
      hasChangeset: messages.some((message) => message.changeset?.counts?.total),
      changesetDetailsOpen,
      pendingSaveViewKey,
      activeTab,
      eventsSubtab,
      sceneView,
      hasLockedChoice: Boolean((playtestSnapshot?.choices || []).some((choice) => choice.disabled)),
      validationStatus: compactValidationStatus,
      board
    });
    setActiveHint(next);
  }, [quickStartOpen, selectedId, activeTab, compactValidationStatus, eventsSubtab, board, isDemoProject, createdEmptyProjectId, sceneView, inspectorFocus, viewKey, pageViewKey, messages, changesetDetailsOpen, pendingSaveViewKey, projectSwitching, conceptHelpOpen, playtestSnapshot]);
  const createProject = async (name) => {
    if (assetOperationRef.current) {
      setBanner(t('workspace.chrome.assetBusyCreate'));
      return;
    }
    try {
      const p = await api.createProject(name);
      await refreshProjects();
      await selectProject(p.id);
      setCreatedEmptyProjectId(p.id);
    } catch (err) {
      setBanner(t('workspace.chrome.createFailed', {
        detail: err.message
      }));
    }
  };
  const handleSceneViewChange = useCallback((next) => {
    setSceneView(next?.kind === 'scene' && eventsSubtab === 'content' ? 'scene' : 'list');
  }, [eventsSubtab]);
  const uploadMaterial = async (filename, content) => {
    try {
      const {
        materials
      } = await api.uploadMaterial(selectedId, filename, content);
      setMaterials(materials || []);
    } catch (err) {
      if (err.status === 423) alert(t('workspace.chrome.generateLocked'));else throw err;
    }
  };
  const deleteMaterial = async (name) => {
    try {
      const {
        materials
      } = await api.deleteMaterial(selectedId, name);
      setMaterials(materials || []);
    } catch (err) {
      alert(err.status === 423 ? t('workspace.chrome.generateLocked') : t('workspace.chrome.deleteFailed', {
        detail: err.message
      }));
    }
  };
  const previewMaterial = async (name, offset = 0) => {
    const preview = await api.previewMaterial(selectedId, name, offset);
    if (offset === 0) {}
    return preview;
  };
  const saveFragment = async (type, content) => {
    try {
      const base = fragments[type]?.revision ?? 0;
      const updated = await api.putData(selectedId, type, content, base);
      setFragments((prev) => ({
        ...prev,
        [type]: updated
      }));
      loadProject(selectedId);
      recordSaveUncheckedHint();
    } catch (err) {
      if (err.status === 409) alert(t('workspace.chrome.revisionConflict'));else if (err.status === 423) alert(t('workspace.chrome.generateLockedPeriod'));else if (err.status === 422) alert(t('workspace.chrome.validationRejected', {
        detail: err.message
      }));else alert(t('workspace.chrome.saveFailed', {
        detail: err.message
      }));
      throw err;
    }
  };
  const handleDirty = useCallback((type, d) => {
    setDirtyMap((m) => m[type] === d ? m : {
      ...m,
      [type]: d
    });
  }, []);
  const handleSceneDirty = useCallback((eventId, dirty) => {
    if (eventId) handleDirty(`scene:${eventId}`, dirty);
  }, [handleDirty]);
  const handleSceneReconcileReady = useCallback((fn) => {
    sceneReconcileRef.current = fn;
  }, []);
  const sendMessage = async (text) => {
    if (assetOperationRef.current) {
      setBanner(formatAssetOperationBusyReason(assetOperationRef.current, t));
      return {
        accepted: false
      };
    }
    if (hasBlockingDraft(dirtyMap)) {
      setBanner(t('workspace.chrome.dirtyBeforeAgent'));
      return {
        accepted: false
      };
    }
    const projectId = selectedId;
    turnEpochRef.current += 1;
    const epoch = turnEpochRef.current;
    settlementCtlRef.current.beginNewTurn();
    setSettlingTurnKey(null);
    setSettlementRetry(false);
    setCurrentTurnId(null);
    chatStartPendingRef.current = true;
    setChatStartPending(true);
    setChatStartTimedOut(false);
    for (const type of DATA_TYPES) {
      fragmentRequestSeq.current[type] = (fragmentRequestSeq.current[type] || 0) + 1;
    }
    refreshCoordinatorRef.current.cancel();
    clearPreviewState();
    setMessages((prev) => [...prev, {
      role: 'user',
      text
    }, {
      role: 'assistant',
      text: '',
      steps: [],
      statusNotes: [],
      streaming: true
    }]);
    setBusy(true);
    setTurnPhase('running');
    const revertOptimistic = () => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && last.streaming) next.pop();
        const user = next[next.length - 1];
        if (user && user.role === 'user' && user.text === text) next.pop();
        return next;
      });
      setBusy(false);
      setTurnPhase('idle');
      setCurrentTurnId(null);
      chatStartPendingRef.current = false;
      setChatStartPending(false);
      setChatStartTimedOut(false);
    };
    const bindReturnedTurn = (turnId) => {
      if (!turnId) return 'missing';
      const current = currentTurnIdRef.current;
      if (current && current !== turnId) return 'conflict';
      setCurrentTurnId(turnId);
      return 'bound';
    };
    try {
      const snapshot = playtestSnapshotRef.current || playtestSnapshot;
      const attachContext = shouldAttachPlaytestContext({
        board,
        mustRestart: Boolean(snapshot?.mustRestart),
        status: snapshot?.status,
        eventId: snapshot?.current?.event_id
      });
      const playtestContext = attachContext ? buildPlaytestRequestPayload({
        status: snapshot.status,
        phase: inferPlaytestPhase(snapshot.status, snapshot.choices),
        current: snapshot.current,
        vars: snapshot.vars,
        takenEdges: snapshot.takenEdges,
        revisions: project?.revisions,
        sceneRevisions: project?.scene_revisions,
        focusEdgeId: playtestFocusEdgeId
      }) : null;
      const payload = await api.chat(projectId, text, locale, playtestContext);
      if (selectedIdRef.current !== projectId || turnEpochRef.current !== epoch) {
        return {
          accepted: false
        };
      }
      chatStartPendingRef.current = false;
      setChatStartPending(false);
      if (payload?.turn_id) {
        const bind = bindReturnedTurn(payload.turn_id);
        if (bind === 'conflict') {
          setBanner(t('workspace.chrome.turnIdMismatch'));
          await reconcileNow({
            startPending: false,
            startTimedOut: true
          });
        }
        return {
          accepted: true
        };
      }
      const result = await reconcileNow({
        startPending: false,
        startTimedOut: true
      });
      if (result?.outcome === 'active') return {
        accepted: true
      };
      revertOptimistic();
      return {
        accepted: false
      };
    } catch (err) {
      if (selectedIdRef.current !== projectId || turnEpochRef.current !== epoch) {
        return {
          accepted: false
        };
      }
      const rejected = err.status >= 400 && err.status < 500;
      if (rejected) {
        revertOptimistic();
        setBanner(err.message || t('workspace.chrome.requestRejected'));
        return {
          accepted: false
        };
      }
      chatStartPendingRef.current = false;
      setChatStartPending(false);
      setChatStartTimedOut(true);
      const result = await reconcileNow({
        startPending: false,
        startTimedOut: true
      });
      if (result?.outcome === 'active') return {
        accepted: true
      };
      if (result?.outcome === 'orphaned' || result?.outcome === 'terminal') {
        return {
          accepted: false
        };
      }
      revertOptimistic();
      setBanner(t('workspace.chrome.sendFailed', {
        detail: err.message || t('common.networkError')
      }));
      return {
        accepted: false
      };
    }
  };
  const stopTurn = () => {
    if (!selectedId || turnPhase !== 'running' || stopBusy) return;
    setStopBusy(true);
    api.stopChat(selectedId).then((payload) => {
      if (payload?.turn_id) setCurrentTurnId(payload.turn_id);
      if (payload?.status === 'stop_requested') setTurnPhase('stop_requested');
    }).catch((err) => {
      setStopBusy(false);
      if (err.status === 409) {
        setBanner(err.message || t('workspace.chrome.stopIdle'));
        chatStartPendingRef.current = false;
        setChatStartPending(false);
        setChatStartTimedOut(true);
        reconcileNow({
          startPending: false,
          startTimedOut: true
        });
        return;
      }
      setBanner(t('workspace.chrome.stopFailed', {
        detail: err.message
      }));
    });
  };
  const continueRemaining = (remaining) => {
    const names = Array.isArray(remaining) ? remaining.join('、') : String(remaining || t('common.remainingContent'));
    sendMessage(t('workspace.chrome.continueRemaining', {
      names
    }));
  };
  const patchChangeset = (changeset) => {
    setMessages((previous) => previous.map((message) => message.changeset?.id === changeset.id ? {
      ...message,
      changeset
    } : message));
  };
  const keepAgentChangeset = async (changeset) => {
    if (isDemoProject) {
      patchChangeset({
        ...changeset,
        status: 'kept',
        resolution: 'explicit_keep'
      });
      return;
    }
    const response = await api.keepAgentChangeset(selectedId, changeset.id);
    patchChangeset(response.changeset);
  };
  const revertAgentChangeset = async (changeset) => {
    if (isDemoProject) {
      setBanner(t('workspace.chrome.demoUndoHint'));
      patchChangeset({
        ...changeset,
        status: 'reverted',
        resolution: 'reverted'
      });
      return;
    }
    const response = await api.revertAgentChangeset(selectedId, changeset.id);
    patchChangeset(response.changeset);
    await loadProject(selectedId);
    await Promise.all(DATA_TYPES.map((type) => loadFragment(selectedId, type)));
    setSceneVersion((value) => value + 1);
    setValidationVersion((value) => value + 1);
    loadReachability(selectedId);
  };
  const locateAgentChange = (detail, changeset) => {
    const location = detail.location || {};
    const navigation = changeNavigation(detail);
    setBoard('build');
    setActiveTab(location.board || detail.data_type || 'events');
    if (location.board === 'world') {
      setWorldFocus((previous) => ({
        objectType: location.object_type,
        objectId: navigation.selectObject ? location.object_id : null,
        seq: previous.seq + 1
      }));
      return;
    }
    if (location.board !== 'events') return;
    setEventsSubtab(location.subtab || 'network');
    if (location.subtab === 'content' && location.event_id) {
      const openDeletedScene = detail.operation === 'remove' && location.object_type === 'scene';
      setSceneOpen((previous) => ({
        id: openDeletedScene ? null : location.event_id,
        focusKind: navigation.selectObject ? location.object_type === 'scene_edge' ? 'edge' : 'beat' : null,
        focusId: navigation.selectObject ? location.object_id : null,
        seq: previous.seq + 1
      }));
      return;
    }
    if (navigation.selectObject && (location.object_type === 'event' || location.object_type === 'event_edge')) {
      setEventFocus((previous) => ({
        kind: location.object_type === 'event_edge' ? 'edge' : 'node',
        id: location.object_id,
        seq: previous.seq + 1
      }));
    } else if (navigation.selectObject && location.object_type === 'state_variable') {
      setEventFocus((previous) => ({
        kind: 'variable',
        id: location.object_id,
        seq: previous.seq + 1
      }));
    } else {
      setEventFocus((previous) => ({
        kind: 'clear',
        id: null,
        seq: previous.seq + 1
      }));
    }
  };
  const generateScene = (eventId, title, hasScene) => {
    const verb = hasScene ? t('common.rewrite') : t('common.generate');
    sendMessage(t('workspace.chrome.generateScene', {
      title,
      eventId,
      verb
    }));
  };
  const runValidation = async () => {
    setEventsSubtab('validation');
    setValidationBusy(true);
    try {
      await api.runValidation(selectedId);
      setValidationVersion((version) => version + 1);
    } catch (err) {
      setBanner(t('workspace.chrome.validationStartFailed', {
        detail: err.message
      }));
      setValidationBusy(false);
    }
  };
  const locateValidationItem = useCallback((item) => {
    const target = validationLocation(item);
    setBoard('build');
    setActiveTab('events');
    if (target.panel === 'scene') {
      setEventsSubtab('content');
      setSceneOpen((previous) => ({
        id: target.eventId,
        focusKind: target.focusKind,
        focusId: target.focusId,
        seq: previous.seq + 1
      }));
      return;
    }
    if (target.panel === 'events') {
      setEventsSubtab('network');
      setEventFocus((previous) => ({
        kind: target.focusKind,
        id: target.focusId,
        seq: previous.seq + 1
      }));
    }
  }, []);
  const locateVariableUsage = useCallback((usage) => {
    setBoard('build');
    setActiveTab('events');
    if (usage.layer === 'scene') {
      setEventsSubtab('content');
      setSceneOpen((previous) => ({
        id: usage.event_id,
        focusKind: usage.object_kind,
        focusId: usage.object_id,
        seq: previous.seq + 1
      }));
      return;
    }
    setEventsSubtab('network');
    setEventFocus((previous) => ({
      kind: usage.object_kind,
      id: usage.object_id,
      seq: previous.seq + 1
    }));
  }, []);
  const openConceptHelp = useCallback((conceptId) => {
    setActiveHint(null);
    setConceptHelpId(conceptId || null);
    setConceptHelpOpen(true);
  }, []);
  const closeConceptHelp = useCallback(() => {
    setConceptHelpOpen(false);
  }, []);
  const navigateConceptDestination = useCallback((destination) => {
    if (!destination) return;
    if (hasBlockingDraft(dirtyMap)) {
      setBanner(t('workspace.chrome.dirtyBeforeNavigate'));
      return;
    }
    if (destination.board) setBoard(destination.board);
    if (destination.tab) setActiveTab(destination.tab);
    if (destination.eventsSubtab) setEventsSubtab(destination.eventsSubtab);
    if (Object.prototype.hasOwnProperty.call(destination, 'openScene')) {
      setSceneOpen((prev) => ({
        id: destination.openScene,
        focusKind: null,
        focusId: null,
        seq: prev.seq + 1
      }));
    }
  }, [dirtyMap, t]);
  const dismissHint = useCallback(() => {
    if (activeHint) markHintSeen(null, activeHint.id);
    setActiveHint(null);
  }, [activeHint]);
  return <ConceptHelpProvider onOpen={openConceptHelp} onClose={closeConceptHelp}>
    <div className="app">
      {<Sidebar projects={projects} selectedId={selectedId} collapsed={sidebarCollapsed} disabled={Boolean(assetOperation)} onSelect={selectProject} onCreate={createProject} onToggle={() => setSidebarCollapsed((value) => !value)} />}

      <main className="build" data-quickstart="build">
        {projectSwitching && <div className="graph-busy-overlay" role="status">{t('workspace.chrome.openingProject')}</div>}
        {banner && <div className="banner" onClick={() => setBanner(null)}>
            {banner}{t('common.clickToDismiss')}
          </div>}
        
        
        {<div className="build-head">
            {selectedId && <>
                <h2>{project?.name}</h2>
                <div className="board-switch">
                  <button type="button" className={`board-tab ${board === 'build' ? 'active' : ''}`} data-quickstart="build-tab" onClick={() => handleBoardChange('build')}>
                    {t('workspace.board.build')}
                  </button>
                  <button type="button" className={`board-tab ${board === 'playtest' ? 'active' : ''}`} data-quickstart="playtest-tab" onClick={() => handleBoardChange('playtest')} disabled={playtestUnavailable} title={playtestTabTitle}>
                    {t('workspace.board.playtest')}
                  </button>
                </div>
                {isDemoProject && <span className="badge">{t('workspace.chrome.demoReadonly')}</span>}
                {busy && <span className="badge badge-busy">
                {turnPhase === 'stop_requested' ? t('workspace.chrome.stoppingReadonly') : t('workspace.chrome.generatingReadonly')}
              </span>}
              </>}
            <div className="build-head-actions">
              <LocaleSwitch />
              <button type="button" className="btn btn-ghost btn-small" data-quickstart="quick-start-rerun" onClick={() => openQuickStart(false)}>
                {t('workspace.chrome.quickStart')}
              </button>
              <ConceptHelpButton />
            </div>
          </div>}
        <ProjectOperationStatus operation={assetOperation} />
        {!selectedId ? <div className="placeholder">
            {t('workspace.chrome.emptyNormal')}
          </div> : <>
            <div className={`board-surface${board === 'playtest' ? '' : ' is-hidden'}`}>
              <div className="build-scroll">
                <PlaytestPanel key={playtestPanelKey(selectedId, {
                isDemo: isDemoProject,
                guideSessionSeq: quickStartPlaytestSeq
              })} projectId={selectedId} disabled={playtestUnavailable} agentTurnActive={agentTurnActive} contentVersionKey={playtestContentKey} playtestTarget={isDemoProject ? quickStartPlaytestTarget : null} onBackToBuild={() => handleBoardChange('build')} onContextChange={handlePlaytestContextChange} onCiteChoice={handleCitePlaytestChoice} />
              </div>
            </div>
            <div className={`board-surface${board === 'build' ? '' : ' is-hidden'}`}>
                <StageTabs tabs={stageTabs} active={activeTab} onChange={handleTabChange} flags={{
              intent: {
                dirty: dirtyMap.intent
              },
              outline: {
                dirty: dirtyMap.outline
              },
              world: {
                dirty: dirtyMap.world
              },
              events: {
                dirty: dirtyMap.events
              }
            }} />
                {}
                <div className="build-scroll build-scroll-stages">
                  <div className="stage-pane" data-quickstart="panel-materials" style={{
                display: activeTab === 'materials' ? 'block' : 'none'
              }}>
                    <MaterialsPanel key={selectedId} materials={materials} disabled={readOnly} onUpload={uploadMaterial} onDelete={deleteMaterial} onPreview={previewMaterial} />
                  </div>
                  <div className="stage-pane" data-quickstart="panel-intent" style={{
                display: activeTab === 'intent' ? 'block' : 'none'
              }}>
                    <PreviewBanner status={previewKeys.intent} />
                    <IntentCard key={selectedId} fragment={fragments.intent} disabled={readOnly} onSave={(c) => saveFragment('intent', c)} onDirtyChange={(d) => handleDirty('intent', d)} />
                  </div>
                  <div className="stage-pane" data-quickstart="panel-outline" style={{
                display: activeTab === 'outline' ? 'block' : 'none'
              }}>
                    <PreviewBanner status={previewKeys.outline} />
                    <OutlineEditor key={selectedId} fragment={fragments.outline} disabled={readOnly} onSave={(c) => saveFragment('outline', c)} onDirtyChange={(d) => handleDirty('outline', d)} />
                  </div>
                  <div className="stage-pane" data-quickstart="panel-world" style={{
                display: activeTab === 'world' ? 'block' : 'none'
              }}>
                    <PreviewBanner status={previewKeys.world} />
                    <WorldForm key={selectedId} fragment={fragments.world} projectId={selectedId} previewAsset={worldPreviewAsset} focusObjectType={worldFocus.objectType} focusObjectId={worldFocus.objectId} focusSeq={worldFocus.seq} disabled={readOnly} onSave={(c) => saveFragment('world', c)} onDirtyChange={(d) => handleDirty('world', d)} onAssetOperationChange={handleAssetOperationChange} onInspectorChange={handleWorldInspectorChange} />
                  </div>
                  <div className="stage-pane" style={{
                display: activeTab === 'events' ? 'block' : 'none'
              }}>
                    <PreviewBanner status={combinedPreviewStatus(previewKeys, eventStagePreviewKeys(previewKeys))} />
                    <div className="event-stage-actions" data-quickstart="validation">
                      <button type="button" className="btn btn-small btn-primary" onClick={runValidation} disabled={busy || validationBusy || Boolean(assetOperation) || isDemoProject || hasUnsavedChanges} title={hasUnsavedChanges ? t('workspace.chrome.saveBeforeValidate') : t('workspace.chrome.runValidationTitle')}>
                        {validationBusy ? t('workspace.chrome.validating') : t('workspace.chrome.runValidation')}
                      </button>
                      <span className={`event-validation-status event-validation-status-${compactValidationStatus}`} aria-live="polite">
                        {VALIDATION_STATUS_ICONS[compactValidationStatus] && <span aria-hidden="true">{VALIDATION_STATUS_ICONS[compactValidationStatus]} </span>}
                        {validationBusy ? t('workspace.chrome.propagating') : t(VALIDATION_STATUS_KEYS[compactValidationStatus] || VALIDATION_STATUS_KEYS.not_checked)}
                      </span>
                      {hasUnsavedChanges && <span className="muted">{t('workspace.chrome.saveBeforeValidate')}</span>}
                    </div>
                    <div className="subtabs" data-quickstart="events-subtabs">
                      <button type="button" className={`subtab ${eventsSubtab === 'network' ? 'active' : ''}`} onClick={() => setEventsSubtab('network')}>
                        {t('workspace.eventsSubtabs.network')}
                      </button>
                      <button type="button" className={`subtab ${eventsSubtab === 'content' ? 'active' : ''}`} onClick={() => setEventsSubtab('content')}>
                        {t('workspace.eventsSubtabs.list')}
                      </button>
                      <button type="button" className={`subtab ${eventsSubtab === 'variables' ? 'active' : ''}`} onClick={() => setEventsSubtab('variables')}>
                        {t('workspace.eventsSubtabs.variables')}
                      </button>
                      <button type="button" className={`subtab ${eventsSubtab === 'validation' ? 'active' : ''}`} onClick={() => setEventsSubtab('validation')}>
                        {t('workspace.eventsSubtabs.validation')}
                      </button>
                    </div>
                    <div style={{
                  display: ['network', 'variables'].includes(eventsSubtab) ? 'block' : 'none'
                }} data-quickstart={eventsSubtab === 'variables' ? 'panel-variables' : undefined}>
                      <EventForm key={selectedId} fragment={fragments.events} projectId={selectedId} world={fragments.world?.content || {}} refreshKey={sceneVersion} reachability={reachability} disabled={readOnly} busy={busy} agentTurnActive={agentTurnActive} settling={Boolean(settlingTurnKey)} onSave={(c) => saveFragment('events', c)} onDirtyChange={(d) => handleDirty('events', d)} focusNodeId={eventFocus.kind === 'node' ? eventFocus.id : null} focusEdgeId={eventFocus.kind === 'edge' ? eventFocus.id : null} focusVariableId={eventFocus.kind === 'variable' ? eventFocus.id : null} focusSeq={eventFocus.seq} view={eventsSubtab} onOpenVariables={() => setEventsSubtab('variables')} onLocateVariableUsage={locateVariableUsage} onGenerate={generateScene} onInspectorChange={handleEventInspectorChange} onOpenScenes={(eventId) => {
                    setEventsSubtab('content');
                    setSceneOpen((p) => ({
                      id: eventId,
                      focusKind: null,
                      focusId: null,
                      seq: p.seq + 1
                    }));
                  }} />
                    </div>
                    <div style={{
                  display: eventsSubtab === 'content' ? 'block' : 'none'
                }} data-quickstart="event-list">
                      <ScenePanel projectId={selectedId} stateVariables={fragments.events?.content?.state_variables || []} eventEdges={fragments.events?.content?.edges || []} world={fragments.world?.content || {}} disabled={readOnly} refreshKey={sceneVersion} previewEventId={scenePreview.eventId} previewSeq={scenePreview.seq} previewBundle={scenePreview.bundle} openEventId={sceneOpen.id} focusKind={sceneOpen.focusKind} focusId={sceneOpen.focusId} openSeq={sceneOpen.seq} agentTurnActive={agentTurnActive} settling={Boolean(settlingTurnKey)} onGenerate={generateScene} onDirtyChange={handleSceneDirty} onReconcileReady={handleSceneReconcileReady} onViewChange={handleSceneViewChange} onInspectorChange={handleSceneInspectorChange} onSaveComplete={recordSaveUncheckedHint} visible={eventsSubtab === 'content'} />
                    </div>
                    <div style={{
                  display: eventsSubtab === 'validation' ? 'block' : 'none'
                }}>
                      {reachability.length > 0 && <div className="reach-warning">
                          <div className="reach-warning-title">
                            ⚠ 当前内容数值门槛预检（{reachability.length}）
                            <span className="muted">
                              ——以下 scalar 门槛即使算上当前已生成情节中的全部有利数值变化也达不到；正式传播完成后以正式报告为准
                            </span>
                          </div>
                          <ul>
                            {reachability.map((warning, index) => <li key={index}>{warning.message}</li>)}
                          </ul>
                        </div>}
                      <PlayabilityCheck projectId={selectedId} disabled={busy || hasUnsavedChanges} disabledReason={hasUnsavedChanges ? t('workspace.chrome.saveBeforeValidate') : ''} refreshKey={validationVersion} onCheckingChange={setValidationBusy} onLocate={locateValidationItem} showRunButton />
                    </div>
                  </div>
                </div>
            </div>
          </>}
      </main>

      {<ChatPanel messages={messages} busy={readOnly && !isDemoProject} busyReason={assetBusyReason || undefined} disabled={!selectedId || isDemoProject} changesetExpanded={tourChangesetExpanded} collapsed={chatPanelCollapsed} width={displayedChatWidth} widthBounds={chatWidthBounds} onWidthChange={updateChatWidth} onSend={sendMessage} onToggle={() => {
        setChatCollapsed((value) => !value);
      }} onKeepChangeset={keepAgentChangeset} onRevertChangeset={revertAgentChangeset} onLocateChange={locateAgentChange} onChangesetDetailsChange={setChangesetDetailsOpen} onContinue={continueRemaining} turnPhase={turnPhase} onStopTurn={stopTurn} stopBusy={stopBusy} contextChip={playtestContextChip({
        stale: board === 'playtest' && Boolean(playtestSnapshot?.mustRestart),
        attachable: shouldAttachPlaytestContext({
          board,
          mustRestart: Boolean(playtestSnapshot?.mustRestart),
          status: playtestSnapshot?.status,
          eventId: playtestSnapshot?.current?.event_id
        }),
        idle: board === 'playtest' && !playtestSnapshot?.started,
        pending: board === 'playtest' && Boolean(playtestSnapshot?.started) && !playtestSnapshot?.mustRestart,
        eventTitle: playtestSnapshot?.eventTitle,
        beatPreview: playtestSnapshot?.beatPreview,
        focusLabel: playtestFocusEdgeId ? (playtestSnapshot?.choices || []).find((choice) => choice.edge?.id === playtestFocusEdgeId)?.label : ''
      })} />}
      
      <Modal open={conceptHelpOpen} title={t('workspace.chrome.conceptHelp')} size="lg" onClose={closeConceptHelp}>
        <ConceptHelpPanel initialConceptId={conceptHelpId} onConceptChange={setConceptHelpId} onNavigate={navigateConceptDestination} navigationContext={{
          hasProject: Boolean(selectedId) && !isDemoProject,
          isDemo: isDemoProject,
          hasDirtyDraft: hasUnsavedChanges,
          selectedEventId: sceneOpen?.id || null
        }} />
      </Modal>
      
      
      
      
      
      
      <ContextualHint hint={activeHint} onDismiss={dismissHint} onLearnMore={(conceptId) => {
        dismissHint();
        openConceptHelp(conceptId);
      }} />
      <QuickStartOverlay open={quickStartOpen} mode='normal' onComplete={completeQuickStart} onDismiss={() => {
        leaveQuickStart({
          restoreSnapshot: true
        });
      }} onStepChange={applyQuickStartStep} />
    </div>
    </ConceptHelpProvider>;
}
