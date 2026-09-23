import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { graphOverlayText } from '../graphContinuity'
import { useSceneResource } from '../hooks/useSceneResource'
import { useT } from '../i18n'
import { ConceptHelpTrigger } from './ConceptHelpContext'
import SceneForm from './SceneForm'

// 场景层（阶段 4）面板：嵌在"事件网络"tab 内，按事件下钻编辑其情节图。
//
// 两级视图：
// 1) 事件列表：以事件图节点为索引，显示每个事件是否已生成情节及版本；
//    每行可"生成/重写情节"（走对话委派 scene-builder）或打开情节网络。
// 2) 情节编辑：选中某事件后，拉取其情节图并用“画布 + 检查器”编辑、手动保存。
//
// 打开情节时先留在列表，读取成功（或已有 last-good）后一次进入画布。刷新已打开情节时
// 不卸载 SceneForm：旧图继续显示，整页只读，覆盖层说明正在刷新。

export default function ScenePanel({
  projectId,
  stateVariables,
  eventEdges,
  world,
  disabled,
  refreshKey,
  previewEventId,
  previewSeq,
  previewBundle,
  openEventId,
  focusKind,
  focusId,
  openSeq,
  agentTurnActive = false,
  settling = false,
  onGenerate,
  onDirtyChange,
  onReconcileReady,
  // onViewChange({ kind, eventId })：list 表示事件列表，scene 表示已画出情节。
  onViewChange,
  // 情节检查器状态；返回列表、读取失败或本页不可见时清空。
  onInspectorChange,
  // 情节保存成功后上报，供「尚未检测」提示绑定当时视图。
  onSaveComplete,
  // 事件列表面板在切走后仍挂载；不可见时不得继续贡献情节检查器。
  visible = true,
}) {
  const t = useT()
  const {
    overview,
    overviewRefreshing,
    sceneRefreshingId,
    overviewError,
    sceneError,
    loadOverview,
    loadScene,
    applyPreviewBundle,
    reconcileVisible,
    lastGoodScene,
  } = useSceneResource({ projectId })
  const [selected, setSelected] = useState(null)
  const [scene, setScene] = useState(null)
  const [openingId, setOpeningId] = useState(null)
  const [pendingRemote, setPendingRemote] = useState(false)
  const selectedRef = useRef(null)
  const dirtyRef = useRef(false)
  selectedRef.current = selected

  /**
   * 把真实可见视图告诉上手提示：只有情节读取成功并画出 SceneForm 才算 scene。
   * @param {{kind: 'list' | 'scene', eventId?: string | null}} next
   */
  const reportView = useCallback((next) => {
    onViewChange?.(next)
  }, [onViewChange])

  /**
   * 情节检查器上报时补上当前事件 id；隐藏或回到列表时清空。
   * @param {{kind: string, id?: string|null}|null} focus
   */
  const handleSceneInspectorChange = useCallback((focus) => {
    if (!visible || !selected || !focus) {
      onInspectorChange?.(null)
      return
    }
    onInspectorChange?.({ ...focus, eventId: selected })
  }, [onInspectorChange, selected, visible])

  useEffect(() => {
    if (!visible) {
      reportView({ kind: 'list', eventId: null })
      onInspectorChange?.(null)
      return
    }
    if (selected && scene) {
      reportView({ kind: 'scene', eventId: selected })
      return
    }
    reportView({ kind: 'list', eventId: null })
    onInspectorChange?.(null)
  }, [visible, projectId, selected, scene, reportView, onInspectorChange])

  const reportSelectedDirty = useCallback(
    (dirty) => {
      dirtyRef.current = Boolean(dirty)
      onDirtyChange?.(selected, dirty)
    },
    [onDirtyChange, selected],
  )

  const applyLoadedScene = useCallback((eventId, nextScene) => {
    if (selectedRef.current === eventId && dirtyRef.current) {
      setPendingRemote(true)
      return
    }
    if (selectedRef.current === eventId || selectedRef.current == null) {
      setScene(nextScene)
      setPendingRemote(false)
    }
  }, [])

  useEffect(() => {
    setSelected(null)
    setScene(null)
    setOpeningId(null)
    setPendingRemote(false)
    dirtyRef.current = false
    if (projectId) {
      loadOverview().catch(() => {})
    }
  }, [projectId, loadOverview])

  useEffect(() => {
    if (!projectId) return undefined
    loadOverview().catch(() => {})
    if (selected) {
      loadScene(selected, { authoritative: !agentTurnActive }).then((result) => {
        if (!result?.stale && result.scene) applyLoadedScene(selected, result.scene)
      }).catch(() => {})
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  useEffect(() => {
    if (!previewBundle || !projectId) return undefined
    applyPreviewBundle(previewBundle)
    const eventId = selectedRef.current
    if (eventId && previewBundle.scenes && Object.prototype.hasOwnProperty.call(previewBundle.scenes, eventId)) {
      const content = previewBundle.scenes[eventId]
      if (content) {
        applyLoadedScene(eventId, {
          event_id: eventId,
          content,
          exists: true,
          has_scene: true,
        })
      }
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSeq, previewBundle])

  /**
   * 打开某事件情节：已有 last-good 则立刻进入画布并后台刷新；否则留在列表直到首次读取成功。
   *
   * @param {string} eventId 事件稳定 id。
   */
  const openScene = async (eventId) => {
    const cached = lastGoodScene(eventId)
    if (cached) {
      setSelected(eventId)
      setScene(cached)
      setOpeningId(null)
      try {
        const result = await loadScene(eventId, { authoritative: true })
        if (!result?.stale && result.scene) applyLoadedScene(eventId, result.scene)
      } catch {
        // 保留 last-good，错误由 sceneError 展示。
      }
      return
    }
    setOpeningId(eventId)
    try {
      const result = await loadScene(eventId, { authoritative: true })
      if (result?.stale) return
      if (result?.scene) {
        setSelected(eventId)
        setScene(result.scene)
      }
    } catch {
      // 留在列表，不进入空的下钻页。
    } finally {
      setOpeningId((current) => (current === eventId ? null : current))
    }
  }

  useEffect(() => {
    if (!openSeq) return undefined
    if (openEventId) {
      openScene(openEventId)
    } else {
      setSelected(null)
      setScene(null)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeq])

  const visibleReconcile = useCallback(async (id) => {
    const ok = await reconcileVisible(id || projectId, selectedRef.current)
    if (!ok) return false
    const snapScene = selectedRef.current ? lastGoodScene(selectedRef.current) : null
    if (selectedRef.current && snapScene) applyLoadedScene(selectedRef.current, snapScene)
    return true
  }, [applyLoadedScene, lastGoodScene, projectId, reconcileVisible])

  useEffect(() => {
    onReconcileReady?.(visibleReconcile)
    return () => onReconcileReady?.(null)
  }, [onReconcileReady, visibleReconcile])

  const saveScene = async (content) => {
    try {
      const base = scene?.revision ?? 0
      const updated = await api.putScene(projectId, selected, content, base)
      setScene(updated)
      setPendingRemote(false)
      dirtyRef.current = false
      loadOverview().catch(() => {})
      onSaveComplete?.()
    } catch (err) {
      if (err.status === 409) alert(t('events.list.revisionConflict'))
      else if (err.status === 423) alert(t('events.list.generateLocked'))
      else if (err.status === 422) alert(t('events.list.validationRejected', { detail: err.message }))
      else alert(t('events.list.saveFailed', { detail: err.message }))
    }
  }

  const retryRefresh = () => {
    loadOverview().catch(() => {})
    if (selected) {
      loadScene(selected, { authoritative: true }).then((result) => {
        if (!result?.stale && result.scene) applyLoadedScene(selected, result.scene)
      }).catch(() => {})
    }
  }

  const listError = overviewError ? t('events.list.loadListFailed', { detail: overviewError.message }) : null
  const openError = sceneError ? t('events.list.loadSceneFailed', { detail: sceneError.message }) : null
  const sceneRefreshing = Boolean(selected && sceneRefreshingId === selected)
  const overlayPhase = (
    sceneRefreshing || settling
      ? 'refreshing'
      : openError && scene
        ? 'stale_error'
        : agentTurnActive && scene && !(scene.content?.beats || []).length
          ? 'generating_empty'
          : null
  )

  // 下钻视图：已有情节快照时持续显示 SceneForm，刷新不得卸载画布。
  if (selected && scene) {
    const meta = (overview || []).find((row) => row.event_id === selected)
    return (
      <div className="scene-panel" data-quickstart="scene">
        {(listError || openError) && (
          <div className="banner">
            {openError || listError}
            <button type="button" className="btn btn-small" onClick={retryRefresh}>{t('common.retry')}</button>
          </div>
        )}
        <SceneForm
          fragment={scene}
          eventTitle={meta?.title}
          stateVariables={stateVariables}
          eventEdges={eventEdges}
          world={world}
          disabled={disabled || sceneRefreshing || settling}
          refreshing={sceneRefreshing || settling}
          overlayText={graphOverlayText(overlayPhase, t)}
          generating={Boolean(agentTurnActive)}
          pendingRemote={pendingRemote}
          focusKind={focusKind}
          focusId={focusId}
          focusSeq={openSeq}
          onSave={saveScene}
          onDirtyChange={reportSelectedDirty}
          onInspectorChange={handleSceneInspectorChange}
          onBack={() => {
            setSelected(null)
            setScene(null)
            setPendingRemote(false)
            dirtyRef.current = false
            reportView({ kind: 'list', eventId: null })
            onInspectorChange?.(null)
          }}
        />
      </div>
    )
  }

  if (overview === null && overviewRefreshing) {
    return <div className="scene-panel"><div className="objlist-empty">{t('artifacts.materials.loading')}</div></div>
  }
  if (overview === null && listError) {
    return (
      <div className="scene-panel">
        <div className="banner">
          {listError}
          <button type="button" className="btn btn-small" onClick={retryRefresh}>{t('common.retry')}</button>
        </div>
      </div>
    )
  }
  if (!overview || overview.length === 0) {
    return (
      <div className="scene-panel">
        {listError && (
          <div className="banner">
            {listError}
            <button type="button" className="btn btn-small" onClick={retryRefresh}>{t('common.retry')}</button>
          </div>
        )}
        <div className="objlist-empty">
          {t('events.list.empty')}
        </div>
      </div>
    )
  }

  return (
    <div className="scene-panel">
      {listError && (
        <div className="banner">
          {listError}
          <button type="button" className="btn btn-small" onClick={retryRefresh}>{t('common.retry')}</button>
        </div>
      )}
      {openingId && (
        <div className="graph-busy-overlay" role="status">{t('events.list.openingStay')}</div>
      )}
      <div className="scene-list-hint muted">
        <ConceptHelpTrigger conceptId="eventList" />
        {t('events.list.hint')}
      </div>
      {overview.map((row) => (
        <div className="scene-row" key={row.event_id}>
          <div className="scene-row-main">
            <span className="scene-row-title">{row.title || row.event_id}</span>
            <span className={`scene-badge scene-badge-${row.type}`}>
              {{ mainline: t('events.types.mainline'), optional: t('events.types.optional'), ending: t('events.types.ending') }[row.type] || row.type}
            </span>
            {row.has_scene ? (
              <span className="scene-status scene-status-ready">{t('events.list.generatedRev', { revision: row.revision })}</span>
            ) : (
              <span className="scene-status scene-status-empty">{t('events.list.notGenerated')}</span>
            )}
          </div>
          <div className="scene-row-actions">
            {row.has_scene && (
              <button
                type="button"
                className="btn btn-small"
                disabled={Boolean(openingId)}
                onClick={() => openScene(row.event_id)}
              >
                {openingId === row.event_id ? t('events.list.opening') : t('events.inspector.openScene')}
              </button>
            )}
            {!disabled && (
              <button
                type="button"
                className="btn btn-small btn-primary"
                onClick={() => onGenerate(row.event_id, row.title || row.event_id, row.has_scene)}
              >
                {row.has_scene ? t('events.list.rewrite') : t('events.list.generate')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
