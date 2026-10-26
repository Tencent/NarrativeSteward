import { useT } from '../i18n'
import { formatPlayStateValue } from '../playStatePresentation.js'
import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Controls, Handle, Position, useReactFlow, useStore } from '@xyflow/react'
import dagre from 'dagre/dist/dagre.js'
import '@xyflow/react/dist/style.css'
import { storyProgress } from './progress.js'
import { Modal } from './ui.jsx'

const EventTile = memo(function EventTile({ data }) {
  const { node, en } = data
  const status = node.current ? (en ? 'You are here' : '当前所在') : node.completed ? (en ? 'Completed' : '已完成') : (en ? 'Explored' : '已探索')
  return <div className={`story-node ${node.locked ? 'is-locked' : 'is-unlocked'}${node.current ? ' is-current' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="event-thumbnail">
      {node.locked ? <span className="unknown-art" aria-hidden="true">?</span> : <>
        {node.image ? <img className="event-landscape" src={node.image} alt="" /> : <span className="event-no-art" aria-hidden="true">◇</span>}
        {node.portrait && <img className="event-portrait" src={node.portrait} alt="" />}
        <span className="event-status">{node.completed && !node.current ? '✓ ' : node.current ? '● ' : ''}{status}</span>
      </>}
    </div>
    <div className="event-name">{node.title}</div>
    <Handle type="source" position={Position.Right} />
  </div>
})
const nodeTypes = { event: EventTile }

/** A dialog initially has zero dimensions. Center only after nodes and viewport exist. */
function MapNavigation({ target, en }) {
  const flow = useReactFlow()
  const width = useStore(state => state.width)
  const height = useStore(state => state.height)
  const viewportReady = useStore(state => Boolean(state.panZoom))
  const focus = (duration = 220) => {
    if (target) flow.setCenter(target.position.x + 110, target.position.y + 81, { zoom: width < 600 ? .82 : 1, duration })
  }
  useEffect(() => {
    if (viewportReady && width && height) {
      focus(0)
    }
  }, [viewportReady, width, height, target?.id, target?.position.x, target?.position.y])
  return <div className="map-navigation">
    <button onClick={() => focus()}>{en ? 'Current event' : '当前事件'}</button>
    <button onClick={() => flow.fitView({ padding: .16, minZoom: .03, maxZoom: 1, duration: 260 })}>{en ? 'Full map' : '全图'}</button>
  </div>
}

export function ProgressDialog({ pt, project, exploration, en, onRewind, onClose }) {
  const t = useT()
  const [tab, setTab] = useState('graph')
  const [selected, setSelected] = useState(null)
  const reviewRef = useRef(null)
  const progress = useMemo(() => storyProgress(project.events, exploration, pt.current?.event_id, pt.takenEdges, pt.routeEventIds), [project, exploration, pt.current, pt.takenEdges, pt.routeEventIds])
  const graph = useMemo(() => {
    const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 65, marginx: 50, marginy: 50 }).setDefaultEdgeLabel(() => ({}))
    progress.nodes.forEach(node => layout.setNode(node.id, { width: 220, height: 162 }))
    progress.edges.forEach(edge => layout.setEdge(edge.source, edge.target, {}, edge.id))
    dagre.layout(layout)
    return {
      nodes: progress.nodes.map(node => ({ id: node.id, type: 'event', position: { x: layout.node(node.id).x - 110, y: layout.node(node.id).y - 81 },
        selected: node.id === selected, selectable: !node.locked, focusable: !node.locked,
        ariaLabel: node.locked ? (en ? 'Locked event' : '未解锁事件') : node.title,
        data: { node, en }, style: { width: 220, height: 162 },
      })),
      edges: progress.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: 'default',
        className: edge.onRoute ? 'current-route' : 'unknown-route', focusable: false, selectable: false,
      })),
    }
  }, [progress, selected, en])
  const detail = progress.nodes.find(node => node.id === selected && !node.locked)
  useEffect(() => { if (reviewRef.current) reviewRef.current.scrollTop = 0 }, [selected])
  const unlocked = progress.nodes.filter(node => !node.locked).length
  return <Modal title={en ? 'Story progress' : '故事进度'} onClose={onClose} en={en} className="progress-dialog">
    <div className="progress-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}>{en ? 'Story map' : '故事地图'}</button>
      <button role="tab" aria-selected={tab === 'state'} onClick={() => setTab('state')}>{en ? 'Current state' : '当前状态'}</button>
      <span>{en ? `${unlocked} / ${progress.nodes.length} events explored` : `已探索 ${unlocked} / ${progress.nodes.length} 个事件`}</span>
    </div>
    {tab === 'state' ? <div className="state-list">
      {pt.varList.length ? pt.varList.map(v => <div key={v.id}><span>{v.name || v.id}</span><strong>{formatPlayStateValue(v, pt.vars[v.id], t)}</strong></div>) : <p>{en ? 'No story state to display.' : '当前没有故事状态。'}</p>}
    </div> : <div className="progress-body">
      <div className="progress-map">
        <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} minZoom={.03} maxZoom={1.6}
          nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} onNodeClick={(_event, node) => { if (!node.data.node.locked) setSelected(node.id) }}
          proOptions={{ hideAttribution: true }} ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': en ? 'Zoom in' : '放大', 'controls.zoomOut.ariaLabel': en ? 'Zoom out' : '缩小' }}>
          <Controls showInteractive={false} showFitView={false} />
          <MapNavigation target={graph.nodes.find(node => node.id === pt.current?.event_id)} en={en} />
        </ReactFlow>
        <div className="map-legend"><span className="legend-current">● {en ? 'Current' : '当前所在'}</span><span className="legend-route">━ {en ? 'Current route' : '当前路线'}</span><span>┄ {en ? 'Other routes' : '其他路线'}</span><span>◇ {en ? 'Unknown' : '未探索'}</span></div>
      </div>
      {detail && <aside ref={reviewRef} className="event-review" aria-label={en ? 'Event review' : '事件回顾'}>
        <div className="review-heading"><h3>{detail.title}</h3><button onClick={() => setSelected(null)} aria-label={en ? 'Close review' : '关闭回顾'}>×</button></div>
        <div className="rewind-controls">
          <p className="review-route-status">{detail.onRoute ? (en ? 'On your current route' : '当前路线') : (en ? 'Explored · not on your current route' : '已探索 · 不在当前路线')}</p>
          {detail.onRoute && <>
            <button className="rewind-button" disabled={pt.isAdvancing} onClick={() => onRewind(detail.id)}>{en ? 'Replay from here' : '回到此处重玩'}</button>
            <p className="review-hint">{en ? 'Restore your state on arrival and choose a new route. Discoveries stay unlocked.' : '恢复当时的状态，重新选择后续路线。已探索的内容仍会保留。'}</p>
          </>}
        </div>
        <p className="review-hint">{en ? 'Discovered excerpts · reviewing does not move your game.' : '已读片段 · 回看不会改变游玩位置。'}</p>
        {detail.rows.map(row => <div className={`review-row ${row.kind}`} key={row.key}>
          {row.kind === 'choice' ? <small>{en ? 'Explored choice' : '已探索的选择'}</small> : row.speaker && <strong>{row.speaker}</strong>}
          <p>{row.content}</p>
        </div>)}
      </aside>}
    </div>}
  </Modal>
}
