import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from '../api'
import { EVENT_GRAPH_LAYOUT, edgeLayoutKey, layoutNarrativeGraph } from '../graphLayout'
import { findEntryNodeId, eventGraphTopologyKey } from '../graphUtils'
import {
  createViewportFitScheduler,
  graphOverlayText,
  selectDisplayedGraph,
  shouldFitAfterCanvasBecomesVisible,
} from '../graphContinuity'
import { stateVariableValueOptions } from '../stateVariableValues'
import { useT } from '../i18n'
import { ConceptHelpTrigger } from './ConceptHelpContext'
import EventNode from './EventNode'
import GraphChoiceEdge from './GraphChoiceEdge'

// 事件网络关系画布：负责总览、搜索、定位，并把节点/边选择交给外层编辑检查器。
// - React Flow 画布 + 前向布局（全局定列、一次落位节点/标签、最后走线；坐标不落盘）。
// - 节点=事件（矩形，事件名 + 类型 + 情节状态点）；边=事件因果，带选项文案/条件锁；
//   c0.30 判为不可达的边标红。
// - MiniMap、搜索定位、聚焦和全屏负责长图导航；单击把对象交给画布侧边检查器精确编辑。

const NODE_W = EVENT_GRAPH_LAYOUT.nodeWidth
const NODE_H = EVENT_GRAPH_LAYOUT.nodeHeight

// 与后端 reachability edge_id 约定一致：优先 edge.id，否则 source->target。
const edgeTag = (e) => e.id || `${e.source}->${e.target}`

function layout(nodeIds, edges) {
  return layoutNarrativeGraph(nodeIds, edges, EVENT_GRAPH_LAYOUT)
}

/**
 * 收集中心事件前后指定层数内的节点，边按无向关系处理以同时保留来路和去路。
 *
 * @param {string} centerId 聚焦中心事件 id。
 * @param {Array<object>} edges 完整事件边列表。
 * @param {number} depth 要保留的相邻层数。
 * @returns {Set<string>} 聚焦范围内的事件 id。
 */
function collectNearbyNodeIds(centerId, edges, depth) {
  const visible = new Set([centerId])
  let frontier = new Set([centerId])
  for (let level = 0; level < depth; level += 1) {
    const next = new Set()
    edges.forEach((edge) => {
      if (frontier.has(edge.source) && !visible.has(edge.target)) next.add(edge.target)
      if (frontier.has(edge.target) && !visible.has(edge.source)) next.add(edge.source)
    })
    next.forEach((id) => visible.add(id))
    frontier = next
    if (frontier.size === 0) break
  }
  return visible
}

const nodeTypes = { event: EventNode }
const edgeTypes = { graphChoice: GraphChoiceEdge }

export default function EventGraphView({
  fragment,
  projectId,
  refreshKey,
  reachability,
  busy = false,
  agentTurnActive = false,
  settling = false,
  onSelectNode,
  onSelectEdge,
  onOpenStateVariables,
  selectedNodeId,
  selectedEdgeId,
  editorMode = false,
}) {
  const t = useT()
  const content = fragment?.content || {}
  const liveNodes = useMemo(() => content.nodes || [], [content])
  const liveEdges = useMemo(() => content.edges || [], [content])
  const liveVars = useMemo(() => content.state_variables || [], [content])
  const lastGoodRef = useRef(null)
  const fitSchedulerRef = useRef(null)
  if (!fitSchedulerRef.current) fitSchedulerRef.current = createViewportFitScheduler()
  const liveGraph = useMemo(
    () => ({ nodes: liveNodes, edges: liveEdges, vars: liveVars }),
    [liveNodes, liveEdges, liveVars],
  )
  const selection = selectDisplayedGraph(lastGoodRef.current, liveGraph, {
    loading: Boolean(settling),
    generating: Boolean(agentTurnActive),
    authoritative: !agentTurnActive && !settling,
    confirmedEmpty: !agentTurnActive && !settling && liveNodes.length === 0,
  })
  lastGoodRef.current = selection.lastGood
  const eventNodes = selection.displayed?.nodes || []
  const eventEdges = selection.displayed?.edges || []
  const stateVars = selection.displayed?.vars || []
  const overlayText = graphOverlayText(selection.phase, t)
  const [flowInstance, setFlowInstance] = useState(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [locatedId, setLocatedId] = useState(null)
  const [focusMode, setFocusMode] = useState(false)
  const [focusDepth, setFocusDepth] = useState(1)
  const [graphHasVisibleSize, setGraphHasVisibleSize] = useState(false)
  const [initialViewportDone, setInitialViewportDone] = useState(false)
  const graphRef = useRef(null)
  const visibilityFitFrameRef = useRef(null)
  const lastCenteredKeyRef = useRef('')
  const lastFocusConfigRef = useRef('full:1')
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const flowInstanceRef = useRef(null)
  const prevSelectionRef = useRef({ node: selectedNodeId, edge: selectedEdgeId })
  flowInstanceRef.current = flowInstance

  // 切换项目时清空上一项目的搜索和定位，避免残留不存在的事件 id。
  useEffect(() => {
    setSearchQuery('')
    setSearchOpen(false)
    setLocatedId(null)
    setIsFullscreen(false)
    setFocusMode(false)
    setFocusDepth(1)
    setGraphHasVisibleSize(false)
    setInitialViewportDone(false)
    lastCenteredKeyRef.current = ''
    lastFocusConfigRef.current = 'full:1'
    lastSizeRef.current = { width: 0, height: 0 }
    lastGoodRef.current = null
    fitSchedulerRef.current.reset()
  }, [projectId])

  useEffect(() => () => {
    fitSchedulerRef.current.cancel()
    if (visibilityFitFrameRef.current != null) {
      window.cancelAnimationFrame(visibilityFitFrameRef.current)
      visibilityFitFrameRef.current = null
    }
  }, [])

  /**
   * 把当前节点铺进可见画布。布局刚写入时需要再等一帧，否则会按旧坐标适配。
   * @param {object|null} instance React Flow 实例。
   */
  const fitVisibleGraph = useCallback((instance, onDone) => {
    if (!instance) {
      onDone?.(false)
      return Promise.resolve(false)
    }
    try {
      return Promise.resolve(instance.fitView({ padding: 0.16, duration: 0 }))
        .then((completed) => {
          onDone?.(completed !== false)
          return completed !== false
        })
        .catch(() => {
          onDone?.(false)
          return false
        })
    } catch {
      onDone?.(false)
      return Promise.resolve(false)
    }
  }, [])

  /**
   * 关系图画布就绪后记住实例；若此时已有节点，立刻铺满，避免空容器先初始化、节点后到却不适应。
   * @param {object} instance React Flow 实例。
   */
  const handleFlowInit = useCallback((instance) => {
    setFlowInstance(instance)
    if (instance.getNodes().length > 0) fitVisibleGraph(instance)
  }, [fitVisibleGraph])

  // 组件会在隐藏标签中提前挂载；只有画布真正获得尺寸后才能可靠初始化视口。
  // 检查器关闭后画布变宽，必须按新尺寸 fitView，否则导览讲连线时会出现空白画布。
  // 根容器必须始终存在：空图时若卸载它，ResizeObserver 不会在节点出现后重新绑定。
  useEffect(() => {
    const element = graphRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const applySize = (width, height) => {
      const visible = width > 100 && height > 100
      setGraphHasVisibleSize(visible)
      if (!visible) {
        setInitialViewportDone(false)
        lastSizeRef.current = { width: 0, height: 0 }
        if (visibilityFitFrameRef.current != null) {
          window.cancelAnimationFrame(visibilityFitFrameRef.current)
          visibilityFitFrameRef.current = null
        }
        return
      }
      const previousSize = lastSizeRef.current
      const currentSize = { width, height }
      const becameVisible = shouldFitAfterCanvasBecomesVisible(previousSize, currentSize)
      lastSizeRef.current = currentSize
      const instance = flowInstanceRef.current
      if (instance && becameVisible) {
        if (visibilityFitFrameRef.current != null) {
          window.cancelAnimationFrame(visibilityFitFrameRef.current)
        }
        visibilityFitFrameRef.current = window.requestAnimationFrame(() => {
          visibilityFitFrameRef.current = null
          fitVisibleGraph(instance, (completed) => {
            if (!completed) return
            setInitialViewportDone(true)
            const flowNodes = instance.getNodes()
            const flowEdges = instance.getEdges()
            fitSchedulerRef.current.markFitted(eventGraphTopologyKey(flowNodes, flowEdges))
          })
        })
      }
    }
    const rect = element.getBoundingClientRect()
    applySize(rect.width, rect.height)
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      applySize(box?.width || 0, box?.height || 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fitVisibleGraph, projectId])

  // 外层检查器或正式检测定位改变节点时，同步画布中心与高亮。
  useEffect(() => {
    if (selectedNodeId && eventNodes.some((node) => node.id === selectedNodeId)) {
      setLocatedId(selectedNodeId)
    }
  }, [eventNodes, selectedNodeId])

  // 外部直接定位一条边时，把其来源事件移到视口中央并高亮该边。
  useEffect(() => {
    if (!selectedEdgeId) return
    const selected = eventEdges.find((edge) => edgeTag(edge) === selectedEdgeId)
    if (selected?.source) setLocatedId(selected.source)
  }, [eventEdges, selectedEdgeId])

  // 搜索只匹配事件标题和稳定 id；限制候选数量，避免结果层遮住大块画布。
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return []
    return eventNodes
      .filter((node) =>
        `${node.title || ''}\n${node.id || ''}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 8)
  }, [eventNodes, searchQuery])

  // 情节生成状态（每事件 has_scene）由 /scenes 总览提供，随 refreshKey 重载。
  const [sceneByEvent, setSceneByEvent] = useState({})
  useEffect(() => {
    if (!projectId) return
    let alive = true
    api
      .listScenes(projectId)
      .then(({ scenes }) => {
        if (!alive) return
        const next = Object.fromEntries((scenes || []).map((scene) => [scene.event_id, scene]))
        setSceneByEvent((previous) => {
          const previousIds = Object.keys(previous)
          const nextIds = Object.keys(next)
          const unchanged = (
            previousIds.length === nextIds.length
            && nextIds.every((eventId) => (
              previous[eventId]?.has_scene === next[eventId]?.has_scene
              && previous[eventId]?.revision === next[eventId]?.revision
            ))
          )
          return unchanged ? previous : next
        })
      })
      .catch(() => {
        // 情节总览失败只影响状态点；保留上一份状态，不能为一次临时失败重建整张事件图。
      })
    return () => {
      alive = false
    }
  }, [projectId, refreshKey])

  // 不可达边 id 集合（来自 c0.30 结构化 warning，图上标红）。终态对账会生成新的
  // warnings 数组；若实际边 id 没变，复用原 Set，避免普通问答后重建全部 React Flow 边。
  const unreachableKey = (reachability || [])
    .map((warning) => warning.edge_id)
    .filter(Boolean)
    .slice()
    .sort()
    .join(',')
  const unreachable = useMemo(
    () => new Set(unreachableKey ? unreachableKey.split(',') : []),
    [unreachableKey],
  )

  /**
   * 选择指定事件并同步更新当前定位中心。
   *
   * @param {string} eventId 要查看的事件稳定 id。
   */
  const openEventDetail = useCallback((eventId) => {
    setLocatedId(eventId)
    onSelectNode?.(eventId)
  }, [onSelectNode])

  // 聚焦模式按双向图距离取前后节点；普通模式保留全部有效事件。
  const visibleIds = useMemo(() => {
    const allIds = new Set(eventNodes.map((node) => node.id).filter(Boolean))
    if (!focusMode || !locatedId || !allIds.has(locatedId)) return allIds
    const nearby = collectNearbyNodeIds(locatedId, eventEdges, focusDepth)
    return new Set([...nearby].filter((id) => allIds.has(id)))
  }, [eventNodes, eventEdges, focusMode, locatedId, focusDepth])

  // 当前可见事件图 → React Flow 节点/边；聚焦时重新紧凑布局，不保留完整图中的空白。
  const computed = useMemo(() => {
    const visibleEdges = eventEdges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    )
    const ids = eventNodes.map((node) => node.id).filter((id) => id && visibleIds.has(id))
    const placed = layout(ids, visibleEdges)
    const pos = placed.nodePositions
    const rfNodes = eventNodes
      .filter((node) => node.id && visibleIds.has(node.id))
      .map((n) => {
        const sc = sceneByEvent[n.id]
        const sceneStatus = !sc || !sc.has_scene ? 'empty' : 'ready'
        return {
          id: n.id,
          type: 'event',
          position: pos[n.id] || { x: 0, y: 0 },
          className: n.id === locatedId || n.id === selectedNodeId ? 'eg-node-located' : undefined,
          data: {
            eventId: n.id,
            title: n.title || n.id,
            kind: n.type || 'mainline',
            sceneStatus,
            onOpenDetail: () => openEventDetail(n.id),
          },
        }
      })
    const rfEdges = visibleEdges
      .filter((e) => e.source && e.target)
      .map((e, i) => {
        const tag = edgeTag(e)
        const bad = unreachable.has(tag)
        const label = e.label || (e.condition ? t('events.network.conditionalFollow') : '')
        return {
          id: e.id || `e-${i}-${tag}`,
          source: e.source,
          target: e.target,
          type: 'graphChoice',
          className: [
            bad ? 'rf-edge-unreachable' : '',
            tag === selectedEdgeId ? 'rf-edge-selected' : '',
          ].filter(Boolean).join(' ') || undefined,
          style: bad
            ? { stroke: '#dc2626', strokeWidth: 2 }
            : tag === selectedEdgeId
              ? { stroke: '#4f46e5', strokeWidth: 3 }
              : { stroke: '#64748b', strokeWidth: 1.75 },
          animated: bad,
          data: {
            sourceEdgeId: tag,
            label,
            fullLabel: `${e.label || t('events.network.missingLabel')}${e.condition ? t('events.network.hasCondition') : ''}`,
            locked: Boolean(e.condition),
            unreachable: bad,
            selected: tag === selectedEdgeId,
            quickstartTarget: `event-edge-${tag}`,
            labelBox: placed.labelBoxes[edgeLayoutKey(e, i)],
            route: placed.edgeRoutes[edgeLayoutKey(e, i)],
            onSelect: () => onSelectEdge?.(tag),
          },
        }
      })
    return { rfNodes, rfEdges }
  }, [eventNodes, eventEdges, sceneByEvent, unreachable, locatedId, selectedNodeId, selectedEdgeId, visibleIds, openEventDetail, onSelectEdge, t])

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  useEffect(() => setNodes(computed.rfNodes), [computed.rfNodes, setNodes])
  useEffect(() => setEdges(computed.rfEdges), [computed.rfEdges, setEdges])

  // 单击节点或边只更新定位和外层检查器，不弹出居中详情。
  const onNodeClick = useCallback((_e, node) => {
    setLocatedId(node.id)
    onSelectNode?.(node.id)
  }, [onSelectNode])
  const onEdgeClick = useCallback((_event, edge) => {
    onSelectEdge?.(edge.data?.sourceEdgeId || edge.id)
  }, [onSelectEdge])
  const locatedNode = eventNodes.find((node) => node.id === locatedId) || null
  const entryNodeId = useMemo(
    () => findEntryNodeId(eventNodes.map((node) => node.id), eventEdges),
    [eventNodes, eventEdges],
  )

  /**
   * 定位并高亮指定事件，不自动打开详情弹窗。
   *
   * @param {string} eventId 目标事件稳定 id。
   */
  const focusEvent = useCallback((eventId) => {
    if (!eventNodes.some((node) => node.id === eventId)) return
    setLocatedId(eventId)
    setSearchQuery(eventNodes.find((node) => node.id === eventId)?.title || eventId)
    setSearchOpen(false)
  }, [eventNodes])

  // 搜索或点选改变中心后，在新布局完成后把对应节点移到视口中央。
  // 检查器关闭后不要再缩到单个节点：500ms 的 setCenter 会盖住随后的 fitView，
  // 导览第 23 步讲连线时就会只剩空白画布。
  useEffect(() => {
    if (!flowInstance || !locatedId) return undefined
    if (!selectedNodeId && !selectedEdgeId) return undefined
    const centerKey = `${locatedId}:${focusMode ? 'focus' : 'full'}`
    if (lastCenteredKeyRef.current === centerKey) return undefined
    const target = computed.rfNodes.find((node) => node.id === locatedId)
    if (!target) return undefined
    lastCenteredKeyRef.current = centerKey
    const timer = window.setTimeout(() => {
      flowInstance.setCenter(
        target.position.x + NODE_W / 2,
        target.position.y + NODE_H / 2,
        { zoom: focusMode ? 1 : 1.2, duration: 500 },
      )
    }, 50)
    return () => window.clearTimeout(timer)
  }, [computed.rfNodes, flowInstance, focusMode, locatedId, selectedEdgeId, selectedNodeId])

  // 节点与可见画布都就绪后只初始化一次；后续数据刷新不覆盖用户的平移与缩放。
  useEffect(() => {
    if (
      !flowInstance
      || !graphHasVisibleSize
      || initialViewportDone
      || nodes.length === 0
    ) return undefined
    const timer = window.setTimeout(() => {
      const markInitialViewportDone = (completed = true) => {
        if (!completed) return
        setInitialViewportDone(true)
        fitSchedulerRef.current.markFitted(eventGraphTopologyKey(eventNodes, eventEdges))
      }
      if (nodes.length <= 8) {
        fitVisibleGraph(flowInstance, markInitialViewportDone)
      } else {
        const entry = nodes.find((node) => node.id === entryNodeId)
        if (entry) {
          Promise.resolve(flowInstance.setCenter(
            entry.position.x + NODE_W / 2,
            entry.position.y + NODE_H / 2,
            { zoom: 1, duration: 0 },
          )).then(() => markInitialViewportDone(true))
        } else {
          fitVisibleGraph(flowInstance, markInitialViewportDone)
        }
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [
    entryNodeId,
    fitVisibleGraph,
    flowInstance,
    graphHasVisibleSize,
    initialViewportDone,
    nodes,
    eventNodes,
    eventEdges,
  ])

  // 节点或边的稳定 id 变化后重新铺满。结构指纹只在铺满真正执行后登记。
  useEffect(() => {
    if (!flowInstance || !graphHasVisibleSize) return undefined
    const nextKey = eventGraphTopologyKey(eventNodes, eventEdges)
    const firstAppearance = !fitSchedulerRef.current.snapshot().fittedKey && !fitSchedulerRef.current.snapshot().pendingKey && !initialViewportDone
    fitSchedulerRef.current.requestFit({
      topologyKey: nextKey,
      firstAppearance,
      fit: (done) => {
        fitVisibleGraph(flowInstance, (completed) => {
          if (!completed) return
          done()
          setInitialViewportDone(true)
        })
      },
    })
    return undefined
  }, [
    eventEdges,
    eventNodes,
    fitVisibleGraph,
    flowInstance,
    graphHasVisibleSize,
    initialViewportDone,
  ])

  // 检查器刚关闭时，小图重新铺满画布。预览刷新增加节点时不改视口，以免打断创作者正在看的位置。
  useEffect(() => {
    const prev = prevSelectionRef.current
    const hadSelection = Boolean(prev.node || prev.edge)
    const hasSelection = Boolean(selectedNodeId || selectedEdgeId)
    prevSelectionRef.current = { node: selectedNodeId, edge: selectedEdgeId }
    if (
      !hadSelection
      || hasSelection
      || !flowInstance
      || !graphHasVisibleSize
      || !initialViewportDone
      || eventNodes.length === 0
      || eventNodes.length > 8
    ) {
      return undefined
    }
    const timer = window.setTimeout(() => {
      flowInstance.fitView({ padding: 0.16, duration: 0 })
      lastCenteredKeyRef.current = `${locatedId || ''}:${focusMode ? 'focus' : 'full'}`
    }, 120)
    return () => window.clearTimeout(timer)
  }, [
    eventNodes.length,
    flowInstance,
    focusMode,
    graphHasVisibleSize,
    initialViewportDone,
    locatedId,
    selectedEdgeId,
    selectedNodeId,
  ])

  // 开关聚焦或改变层数后适配当前子图；首次初始化前不抢写视口。
  useEffect(() => {
    if (!flowInstance || !initialViewportDone || nodes.length === 0) return undefined
    const focusConfig = `${focusMode ? 'focus' : 'full'}:${focusDepth}`
    if (lastFocusConfigRef.current === focusConfig) return undefined
    lastFocusConfigRef.current = focusConfig
    const timer = window.setTimeout(() => {
      flowInstance.fitView({ padding: 0.16, duration: 400 })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [flowInstance, focusMode, focusDepth, initialViewportDone, nodes.length])

  // 全屏期间锁住页面滚动并支持 Esc 退出；退出后恢复进入前的 body overflow。
  useEffect(() => {
    if (!isFullscreen) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setIsFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isFullscreen])

  // 画布尺寸在全屏切换后发生变化，等待布局完成再重新适应全部节点。
  useEffect(() => {
    if (!flowInstance || !initialViewportDone || nodes.length === 0) return undefined
    const timer = window.setTimeout(() => {
      flowInstance.fitView({ padding: 0.12, duration: 400 })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [flowInstance, isFullscreen, initialViewportDone, nodes.length])

  return (
    <div
      ref={graphRef}
      className={`eventgraph${isFullscreen ? ' eventgraph-fullscreen' : ''}`}
    >
      {eventNodes.length === 0 && (
        <div className="objlist-empty eventgraph-empty">
          {selection.phase === 'generating_empty' || selection.phase === 'initial_loading'
            ? t('events.network.generating')
            : t('events.network.empty')}
        </div>
      )}
      {overlayText && (
        <div className="graph-busy-overlay" role="status">
          {overlayText}
        </div>
      )}
      <div className="eg-graph-toolbar">
        <ConceptHelpTrigger conceptId="eventNetwork" />
        <div
          className="eg-search"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false)
          }}
        >
          <div className="eg-search-input-wrap">
            <input
              type="search"
              className="eg-search-input"
              value={searchQuery}
              placeholder={t('events.network.search')}
              aria-label={t('events.network.search')}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchMatches[0]) {
                  event.preventDefault()
                  focusEvent(searchMatches[0].id)
                }
              }}
            />
            {searchQuery && (
              <button
                type="button"
                className="eg-search-clear"
                aria-label={t('events.network.clearSearch')}
                onClick={() => {
                  setSearchQuery('')
                  setLocatedId(null)
                  setFocusMode(false)
                  setSearchOpen(false)
                }}
              >
                ×
              </button>
            )}
          </div>
          {searchOpen && searchQuery.trim() && (
            <div className="eg-search-results">
              {searchMatches.length > 0 ? (
                searchMatches.map((node) => (
                  <button type="button" key={node.id} onClick={() => focusEvent(node.id)}>
                    <span>{node.title || node.id}</span>
                    <span className="muted">{node.id}</span>
                  </button>
                ))
              ) : (
                <div className="eg-search-empty">{t('events.network.noMatch')}</div>
              )}
            </div>
          )}
        </div>
        {locatedNode && (
          <div className="eg-current-event" title={`${locatedNode.title || locatedNode.id} · ${locatedNode.id}`}>
            <span className="eg-current-event-title">{locatedNode.title || locatedNode.id}</span>
            <span className="eg-current-event-id">{locatedNode.id}</span>
            <button type="button" onClick={() => onSelectNode?.(locatedNode.id)}>
              {t('common.edit')}
            </button>
          </div>
        )}
        {editorMode && (
          <button type="button" className="btn btn-small btn-ghost eg-toolbar-btn" onClick={onOpenStateVariables}>
            {t('events.variables.title')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-small btn-ghost eg-toolbar-btn"
          onClick={() => flowInstance?.fitView({ padding: 0.12, duration: 500 })}
          disabled={!flowInstance}
        >
          {focusMode ? t('events.network.fitCurrent') : t('events.network.fitAll')}
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost eg-toolbar-btn"
          disabled={!flowInstance || !entryNodeId}
          onClick={() => {
            const entry = computed.rfNodes.find((node) => node.id === entryNodeId)
            if (!entry) return
            setLocatedId(entryNodeId)
            lastCenteredKeyRef.current = ''
            flowInstance.setCenter(
              entry.position.x + NODE_W / 2,
              entry.position.y + NODE_H / 2,
              { zoom: 1.1, duration: 400 },
            )
            lastCenteredKeyRef.current = `${entryNodeId}:${focusMode ? 'focus' : 'full'}`
          }}
        >
          {t('events.network.backToEntry')}
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost eg-toolbar-btn"
          aria-pressed={focusMode}
          title={locatedId ? t('events.network.focusAround', { id: locatedId }) : t('events.network.focusNeedSelection')}
          disabled={!locatedId}
          onClick={() => setFocusMode((value) => !value)}
        >
          {focusMode ? t('events.network.exitFocus') : t('events.network.focusCurrent')}
        </button>
        {focusMode && (
          <div className="eg-focus-depth" aria-label={t('events.network.focusRange')}>
            <span>{t('events.network.around')}</span>
            {[1, 2].map((depth) => (
              <button
                type="button"
                key={depth}
                className={focusDepth === depth ? 'active' : ''}
                aria-pressed={focusDepth === depth}
                onClick={() => setFocusDepth(depth)}
              >
                {t('events.network.layers', { n: depth })}
              </button>
            ))}
            <span className="eg-focus-count">
              {visibleIds.size}/{eventNodes.length}
            </span>
          </div>
        )}
        <button
          type="button"
          className="btn btn-small btn-ghost eg-toolbar-btn"
          aria-pressed={isFullscreen}
          title={isFullscreen ? t('events.network.exitFullscreen') : t('events.network.enterFullscreenHint')}
          onClick={() => setIsFullscreen((value) => !value)}
        >
          {isFullscreen ? t('events.network.exitFullscreenShort') : t('events.network.fullscreen')}
        </button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onInit={handleFlowInit}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={editorMode}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={3}
          nodeColor={(node) => {
            if (node.data?.kind === 'ending') return '#16a34a'
            if (node.data?.kind === 'optional') return '#0ea5e9'
            return '#4f46e5'
          }}
          maskColor="rgba(30, 41, 59, 0.16)"
        />
      </ReactFlow>

      {!editorMode && <StateVarPanel vars={stateVars} />}
    </div>
  )
}

/**
 * 事件画布右上角的状态变量浮层。
 *
 * @param {object} props
 * @param {Array<object>} props.vars 状态变量定义列表。
 */
function StateVarPanel({ vars }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const typeShort = {
    flag: t('events.types.flagShort'),
    enum: t('events.types.enumShort'),
    scalar: t('events.types.scalarShort'),
  }
  return (
    <div className="eg-statevar">
      <button
        type="button"
        className="btn btn-small btn-ghost"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t('events.variables.count', { count: vars.length })}{open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="eg-statevar-list">
          {vars.length === 0 && <div className="muted">{t('events.variables.none')}</div>}
          {vars.map((v) => (
            <div className="eg-statevar-row" key={v.id || v.name}>
              <span className="eg-statevar-name">{v.name || v.id}</span>
              <span className="eg-statevar-meta">
                {typeShort[v.type] || v.type}
                {['flag', 'enum'].includes(v.type) && (
                  stateVariableValueOptions(v, t).map((option) => (
                    <span className="eg-statevar-value" key={option.value}>
                      {option.label}
                    </span>
                  ))
                )}
                {v.type === 'scalar' ? `: ${v.min ?? '−∞'}~${v.max ?? '+∞'}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
