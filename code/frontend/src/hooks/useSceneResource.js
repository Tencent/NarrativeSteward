import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../api.js'
import { createLatestWinsMap, hasGraphContent } from '../graphContinuity.js'

/**
 * 情节总览与已打开情节的 last-good 缓存、latest-wins 代次与终态对账读取。
 *
 * 迟到的 listScenes / getScene 不能覆盖更新的预览或另一个项目；权威空结果可以清掉该事件缓存。
 *
 * @param {object} options
 * @param {(projectId: string) => Promise<{scenes?: Array<object>}>} options.listScenes
 * @param {(projectId: string, eventId: string) => Promise<object>} options.getScene
 * @returns {{
 *   loadOverview: Function,
 *   loadScene: Function,
 *   reconcileVisible: Function,
 *   resetProject: Function,
 *   snapshot: Function,
 * }}
 */
export function createSceneResourceController(options) {
  const listScenes = options.listScenes
  const getScene = options.getScene
  const generations = createLatestWinsMap()
  let overview = null
  const scenes = new Map()
  let overviewError = null
  const sceneErrors = new Map()

  function overviewKey(projectId) {
    return `${projectId}:overview`
  }

  function sceneKey(projectId, eventId) {
    return `${projectId}:scene:${eventId}`
  }

  function snapshot() {
    return {
      overview,
      scenes: Object.fromEntries(scenes),
      overviewError,
      sceneErrors: Object.fromEntries(sceneErrors),
    }
  }

  /**
   * 清空上一项目的总览与情节缓存，并作废进行中的请求。
   *
   * @param {string} [prefix] 只作废该项目前缀；不传则全部清空。
   */
  function resetProject(prefix) {
    generations.reset(prefix)
    overview = null
    scenes.clear()
    overviewError = null
    sceneErrors.clear()
  }

  /**
   * 读取情节总览。成功后更新 last-good；失败保留旧总览并抛出，供调用方显示可重试错误。
   *
   * @param {string} projectId
   * @returns {Promise<{stale: boolean, scenes?: Array|null, error?: Error}>}
   */
  async function loadOverview(projectId) {
    const key = overviewKey(projectId)
    const generation = generations.begin(key)
    try {
      const payload = await listScenes(projectId)
      if (!generations.isCurrent(key, generation)) return { stale: true, scenes: overview }
      overview = payload?.scenes || []
      overviewError = null
      return { stale: false, scenes: overview }
    } catch (error) {
      if (!generations.isCurrent(key, generation)) return { stale: true, error, scenes: overview }
      overviewError = error
      throw error
    }
  }

  /**
   * 读取单个事件情节。非空结果与权威空结果更新 last-good；空预览不覆盖已有图。
   *
   * @param {string} projectId
   * @param {string} eventId
   * @param {object} [context]
   * @param {boolean} [context.authoritative] 终态对账、手动保存或用户主动打开后的正式读取。
   * @returns {Promise<{stale: boolean, scene?: object|null, keptLastGood?: boolean, error?: Error}>}
   */
  async function loadScene(projectId, eventId, { authoritative = false } = {}) {
    const key = sceneKey(projectId, eventId)
    const generation = generations.begin(key)
    try {
      const scene = await getScene(projectId, eventId)
      if (!generations.isCurrent(key, generation)) {
        return { stale: true, scene: scenes.get(eventId) || null }
      }
      const lastGood = scenes.get(eventId) || null
      const candidateHas = hasGraphContent(scene?.content)
      const confirmedEmpty = authoritative && !candidateHas && scene?.has_scene === false
      if (candidateHas || authoritative) {
        if (confirmedEmpty) scenes.delete(eventId)
        else scenes.set(eventId, scene)
        sceneErrors.delete(eventId)
        return { stale: false, scene: scenes.get(eventId) || scene, keptLastGood: false }
      }
      if (lastGood) {
        return { stale: false, scene: lastGood, keptLastGood: true }
      }
      scenes.set(eventId, scene)
      sceneErrors.delete(eventId)
      return { stale: false, scene, keptLastGood: false }
    } catch (error) {
      if (!generations.isCurrent(key, generation)) {
        return { stale: true, error, scene: scenes.get(eventId) || null }
      }
      sceneErrors.set(eventId, error)
      throw error
    }
  }

  /**
   * 终态对账必须等到总览成功；若当前已打开某事件，还必须等到该情节成功。
   * 任一失败抛错，整轮不得登记已对账。
   *
   * @param {string} projectId
   * @param {string|null} [openEventId]
   * @returns {Promise<boolean>}
   */
  async function reconcileVisible(projectId, openEventId = null) {
    const overviewResult = await loadOverview(projectId)
    if (overviewResult.stale) return false
    if (openEventId) {
      const sceneResult = await loadScene(projectId, openEventId, { authoritative: true })
      if (sceneResult.stale) return false
    }
    return true
  }

  return {
    loadOverview,
    loadScene,
    reconcileVisible,
    resetProject,
    snapshot,
    peekGeneration: (key) => generations.peek(key),
    /**
     * 把检查点 bundle 中的情节总览与正文一次写入 last-good，并作废在途 GET。
     * @param {string} projectId
     * @param {{scene_overview?: Array, scenes?: Record<string, object>, targets?: Array}} bundle
     */
    applyPreviewBundle(projectId, bundle) {
      generations.begin(overviewKey(projectId))
      if (Array.isArray(bundle?.scene_overview)) {
        overview = bundle.scene_overview
        overviewError = null
      }
      const sceneMap = bundle?.scenes || {}
      for (const eventId of Object.keys(sceneMap)) {
        generations.begin(sceneKey(projectId, eventId))
        const content = sceneMap[eventId]
        if (content == null) {
          scenes.delete(eventId)
          continue
        }
        scenes.set(eventId, {
          event_id: eventId,
          content,
          exists: true,
          has_scene: true,
          revision: 0,
        })
        sceneErrors.delete(eventId)
      }
      for (const target of bundle?.targets || []) {
        if (target?.data_type === 'scenes' && target.deleted && target.event_id) {
          generations.begin(sceneKey(projectId, target.event_id))
          scenes.delete(target.event_id)
        }
      }
    },
  }
}

/**
 * 把情节资源控制器接到 React 状态，供 ScenePanel 保持总览与已打开情节可见。
 *
 * @param {object} props
 * @param {string|null} props.projectId
 * @returns {object} 总览、当前情节、刷新错误与加载入口。
 */
export function useSceneResource({ projectId }) {
  const controllerRef = useRef(null)
  if (!controllerRef.current) {
    controllerRef.current = createSceneResourceController({
      listScenes: (id) => api.listScenes(id),
      getScene: (id, eventId) => api.getScene(id, eventId),
    })
  }

  const overviewFlightRef = useRef(0)
  const sceneFlightRef = useRef(0)
  const [overview, setOverview] = useState(null)
  const [sceneCache, setSceneCache] = useState({})
  const [overviewRefreshing, setOverviewRefreshing] = useState(false)
  const [sceneRefreshingId, setSceneRefreshingId] = useState(null)
  const [overviewError, setOverviewError] = useState(null)
  const [sceneError, setSceneError] = useState(null)

  const syncFromController = useCallback(() => {
    const snap = controllerRef.current.snapshot()
    setOverview(snap.overview)
    setSceneCache(snap.scenes)
  }, [])

  useEffect(() => {
    controllerRef.current.resetProject()
    setOverview(null)
    setSceneCache({})
    setOverviewError(null)
    setSceneError(null)
    setOverviewRefreshing(false)
    setSceneRefreshingId(null)
  }, [projectId])

  const loadOverview = useCallback(async () => {
    if (!projectId) return { stale: true, scenes: null }
    const flight = overviewFlightRef.current + 1
    overviewFlightRef.current = flight
    setOverviewRefreshing(true)
    try {
      const result = await controllerRef.current.loadOverview(projectId)
      if (!result.stale) {
        syncFromController()
        setOverviewError(null)
      }
      return result
    } catch (error) {
      setOverviewError(error)
      syncFromController()
      throw error
    } finally {
      if (overviewFlightRef.current === flight) setOverviewRefreshing(false)
    }
  }, [projectId, syncFromController])

  const loadScene = useCallback(async (eventId, context = {}) => {
    if (!projectId || !eventId) return { stale: true, scene: null }
    const flight = sceneFlightRef.current + 1
    sceneFlightRef.current = flight
    setSceneRefreshingId(eventId)
    try {
      const result = await controllerRef.current.loadScene(projectId, eventId, context)
      if (!result.stale) {
        syncFromController()
        setSceneError(null)
      }
      return result
    } catch (error) {
      setSceneError(error)
      syncFromController()
      throw error
    } finally {
      if (sceneFlightRef.current === flight) {
        setSceneRefreshingId((current) => (current === eventId ? null : current))
      }
    }
  }, [projectId, syncFromController])

  const applyPreviewBundle = useCallback((bundle) => {
    if (!projectId || !bundle) return
    controllerRef.current.applyPreviewBundle(projectId, bundle)
    syncFromController()
    setOverviewError(null)
    setSceneError(null)
  }, [projectId, syncFromController])

  const reconcileVisible = useCallback(async (id, openEventId = null) => {
    const targetId = id || projectId
    if (!targetId) return false
    try {
      const ok = await controllerRef.current.reconcileVisible(targetId, openEventId)
      syncFromController()
      setOverviewError(null)
      setSceneError(null)
      return ok
    } catch (error) {
      syncFromController()
      setOverviewError(error)
      throw error
    }
  }, [projectId, syncFromController])

  return {
    overview,
    sceneCache,
    overviewRefreshing,
    sceneRefreshingId,
    overviewError,
    sceneError,
    loadOverview,
    loadScene,
    applyPreviewBundle,
    reconcileVisible,
    lastGoodScene: (eventId) => controllerRef.current.snapshot().scenes[eventId] || null,
  }
}
