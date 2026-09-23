import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createViewportFitScheduler,
  graphOverlayText,
  selectDisplayedGraph,
  shouldFitAfterCanvasBecomesVisible,
} from '../graphContinuity'
import { edgeLayoutKey, layoutNarrativeGraph, SCENE_GRAPH_LAYOUT } from '../graphLayout'
import { graphTopologyKey } from '../graphUtils'
import { useT } from '../i18n'
import GraphChoiceEdge from './GraphChoiceEdge'
import SceneBeatNode from './SceneBeatNode'

// 单事件情节关系画布：beat 为节点、选择为边，与事件图共用前向布局（左→右）。
// 画布只负责总览与选择，精确编辑由 SceneForm 的侧边检查器承担；坐标不写回业务数据。
// 边标签与事件网络共用 GraphChoiceEdge，避免 SVG 单行字压住连线。
// 连续呈现：刷新、失败、生成中空候选都继续显示上一份有效图；只有权威空结果才清空。

const nodeTypes = { beat: SceneBeatNode }
const edgeTypes = { graphChoice: GraphChoiceEdge }

// 与后端 edge tag 约定一致：优先 edge.id，否则 source->target。
const edgeTag = (e) => e.id || `${e.source}->${e.target}`

function layout(nodeIds, edges) {
  return layoutNarrativeGraph(nodeIds, edges, SCENE_GRAPH_LAYOUT)
}

/**
 * @param {object} content 情节图内容 {event_id, beats, edges}
 * @param {string|null} [eventId] 当前事件 id，切换时清空视口指纹。
 * @param {(speaker: string) => string} [speakerDisplayName] 把 speaker 解析成画布显示名。
 * @param {string|null} selectedBeatId 当前检查器选中的 beat。
 * @param {string|null} selectedEdgeId 当前检查器选中的边。
 * @param {boolean} [refreshing] 正在读取新快照。
 * @param {boolean} [generating] Agent 回合仍在进行。
 * @param {boolean} [confirmedEmpty] 权威读取确认尚未生成或正式为空。
 * @param {string|null} [overlayText] 外层指定的覆盖层文案；缺省时按呈现相位生成。
 * @param {(id: string) => void} onSelectBeat 选择 beat 的回调。
 * @param {(id: string) => void} onSelectEdge 选择边的回调。
 */
export default function SceneGraphView({
  content,
  eventId = null,
  speakerDisplayName = (speaker) => speaker || '',
  selectedBeatId = null,
  selectedEdgeId = null,
  refreshing = false,
  generating = false,
  confirmedEmpty = false,
  overlayText = null,
  onSelectBeat,
  onSelectEdge,
}) {
  const t = useT()
  const liveBeats = useMemo(() => content?.beats || [], [content])
  const liveEdges = useMemo(() => content?.edges || [], [content])
  const lastGoodRef = useRef(null)
  const fitSchedulerRef = useRef(null)
  if (!fitSchedulerRef.current) fitSchedulerRef.current = createViewportFitScheduler()
  const liveGraph = useMemo(
    () => ({ beats: liveBeats, edges: liveEdges }),
    [liveBeats, liveEdges],
  )
  const selection = selectDisplayedGraph(lastGoodRef.current, liveGraph, {
    loading: Boolean(refreshing),
    generating: Boolean(generating),
    authoritative: !generating && !refreshing,
    confirmedEmpty: Boolean(confirmedEmpty) && !generating && !refreshing && liveBeats.length === 0,
  })
  lastGoodRef.current = selection.lastGood
  const beats = selection.displayed?.beats || []
  const sceneEdges = selection.displayed?.edges || []
  const overlay = overlayText || graphOverlayText(selection.phase, t)

  const [flowInstance, setFlowInstance] = useState(null)
  const [graphHasVisibleSize, setGraphHasVisibleSize] = useState(false)
  const graphRef = useRef(null)
  const flowInstanceRef = useRef(null)
  const lastSizeRef = useRef({ width: 0, height: 0 })
  const visibilityFitFrameRef = useRef(null)
  flowInstanceRef.current = flowInstance

  const speakerName = useCallback((s) => (s ? speakerDisplayName(s) : ''), [speakerDisplayName])

  useEffect(() => {
    lastGoodRef.current = null
    fitSchedulerRef.current.reset()
    lastSizeRef.current = { width: 0, height: 0 }
    setGraphHasVisibleSize(false)
    if (visibilityFitFrameRef.current != null) {
      window.cancelAnimationFrame(visibilityFitFrameRef.current)
      visibilityFitFrameRef.current = null
    }
  }, [eventId])

  useEffect(() => () => {
    fitSchedulerRef.current.cancel()
    if (visibilityFitFrameRef.current != null) {
      window.cancelAnimationFrame(visibilityFitFrameRef.current)
      visibilityFitFrameRef.current = null
    }
  }, [])

  const fitVisibleGraph = useCallback((instance, onDone) => {
    if (!instance) {
      onDone?.(false)
      return Promise.resolve(false)
    }
    try {
      return Promise.resolve(instance.fitView({ padding: 0.18, duration: 0 }))
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

  const handleFlowInit = useCallback((instance) => {
    setFlowInstance(instance)
    if (instance.getNodes().length > 0) {
      fitVisibleGraph(instance, (completed) => {
        if (!completed) return
        fitSchedulerRef.current.markFitted(
          graphTopologyKey(instance.getNodes(), instance.getEdges()),
        )
      })
    }
  }, [fitVisibleGraph])

  useEffect(() => {
    const element = graphRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const applySize = (width, height) => {
      const visible = width > 80 && height > 80
      setGraphHasVisibleSize(visible)
      if (!visible) {
        lastSizeRef.current = { width: 0, height: 0 }
        if (visibilityFitFrameRef.current != null) {
          window.cancelAnimationFrame(visibilityFitFrameRef.current)
          visibilityFitFrameRef.current = null
        }
        return
      }
      const currentSize = { width, height }
      const becameVisible = shouldFitAfterCanvasBecomesVisible(
        lastSizeRef.current,
        currentSize,
        80,
      )
      lastSizeRef.current = currentSize
      const instance = flowInstanceRef.current
      if (becameVisible && instance && instance.getNodes().length > 0) {
        if (visibilityFitFrameRef.current != null) {
          window.cancelAnimationFrame(visibilityFitFrameRef.current)
        }
        visibilityFitFrameRef.current = window.requestAnimationFrame(() => {
          visibilityFitFrameRef.current = null
          fitVisibleGraph(instance, (completed) => {
            if (!completed) return
            fitSchedulerRef.current.markFitted(
              graphTopologyKey(instance.getNodes(), instance.getEdges()),
            )
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
  }, [eventId, fitVisibleGraph])

  const computed = useMemo(() => {
    const ids = beats.map((b) => b.id).filter(Boolean)
    const visibleEdges = sceneEdges.filter((e) => e.source && e.target)
    const placed = layout(ids, visibleEdges)
    const pos = placed.nodePositions
    const rfNodes = beats
      .filter((b) => b.id)
      .map((b) => ({
        id: b.id,
        type: 'beat',
        position: pos[b.id] || { x: 0, y: 0 },
        data: { kind: b.kind || 'narration', speaker: speakerName(b.speaker), content: b.content || '' },
        selected: b.id === selectedBeatId,
      }))
    const rfEdges = visibleEdges
      .map((e, i) => {
        const tag = edgeTag(e)
        const selected = tag === selectedEdgeId
        const label = e.label || (e.condition ? t('events.network.conditionalFollow') : '')
        const layoutKey = edgeLayoutKey(e, i)
        return {
          id: tag,
          source: e.source,
          target: e.target,
          type: 'graphChoice',
          className: selected ? 'rf-edge-selected' : undefined,
          style: selected
            ? { stroke: '#4f46e5', strokeWidth: 3 }
            : { stroke: '#64748b', strokeWidth: 1.75 },
          data: {
            label,
            fullLabel: `${e.label || t('events.network.missingLabel')}${e.condition ? t('events.network.hasCondition') : ''}`,
            locked: Boolean(e.condition),
            selected,
            labelBox: placed.labelBoxes[layoutKey],
            route: placed.edgeRoutes[layoutKey],
            quickstartTarget: `scene-edge-${tag}`,
            onSelect: () => onSelectEdge?.(tag),
          },
        }
      })
    return { rfNodes, rfEdges }
  }, [beats, sceneEdges, selectedBeatId, selectedEdgeId, speakerName, onSelectEdge, t])

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  useEffect(() => setNodes(computed.rfNodes), [computed.rfNodes, setNodes])
  useEffect(() => setEdges(computed.rfEdges), [computed.rfEdges, setEdges])

  useEffect(() => {
    if (!flowInstance || !graphHasVisibleSize || beats.length === 0) return undefined
    const nextKey = graphTopologyKey(beats, sceneEdges)
    fitSchedulerRef.current.requestFit({
      topologyKey: nextKey,
      firstAppearance: false,
      fit: (done) => {
        fitVisibleGraph(flowInstance, (completed) => {
          if (completed) done()
        })
      },
    })
    return undefined
  }, [beats, fitVisibleGraph, flowInstance, graphHasVisibleSize, sceneEdges])

  const onNodeClick = useCallback((_event, node) => onSelectBeat?.(node.id), [onSelectBeat])
  const onEdgeClick = useCallback((_event, edge) => onSelectEdge?.(edge.id), [onSelectEdge])

  const emptyHint = (
    selection.phase === 'generating_empty' || selection.phase === 'initial_loading'
      ? t('events.scene.generating')
      : confirmedEmpty || !beats.length
        ? t('events.scene.missing')
        : t('events.scene.empty')
  )

  return (
    <div className="scenegraph" ref={graphRef}>
      {beats.length === 0 && (
        <div className="objlist-empty eventgraph-empty">{emptyHint}</div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={handleFlowInit}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={Boolean(onSelectEdge)}
        fitViewOptions={{ padding: 0.18 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background gap={14} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="eg-graph-toolbar scenegraph-toolbar">
        <button
          type="button"
          className="btn btn-small"
          disabled={!flowInstance || beats.length === 0}
          onClick={() => {
            fitVisibleGraph(flowInstance, (completed) => {
              if (!completed) return
              fitSchedulerRef.current.markFitted(graphTopologyKey(beats, sceneEdges))
            })
          }}
        >
          {t('events.network.fitAll') /* 适应全图 */}
        </button>
      </div>
      {overlay && (
        <div className="graph-busy-overlay" role="status">
          {overlay}
        </div>
      )}
    </div>
  )
}
