import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react'
import { useT } from '../i18n'
import {
  GRAPH_EDGE_LABEL_MAX_WIDTH,
  GRAPH_EDGE_LABEL_OFFSET_Y,
  applyRouteHandles,
  graphChoiceBezierPath,
  roundedOrthogonalPath,
} from '../graphLayout'

/**
 * 事件网络与情节网络共用的可点击边。
 *
 * 优先使用前向布局预计算的折线和标签框；路径缺失时回退到钉住端点的贝塞尔。
 * 标签最多两行，可见卡片撑满预留槽位，悬停显示全文，点击等同选中该边。
 *
 * @param {object} props React Flow 自定义边参数。
 * @param {object} [props.data] 展示数据。
 * @param {string} [props.data.label] 画布上截断显示的文案。
 * @param {string} [props.data.fullLabel] 悬停全文。
 * @param {boolean} [props.data.locked] 是否有解锁条件。
 * @param {boolean} [props.data.unreachable] 是否被检测判为不可达。
 * @param {boolean} [props.data.selected] 是否为当前选中边。
 * @param {{x:number,y:number,width:number,height:number}} [props.data.labelBox] 预计算标签框。
 * @param {{points?: Array<{x:number,y:number}>, path?: string}} [props.data.route] 预计算走线。
 * @param {() => void} [props.data.onSelect] 点击标签时选中该边。
 */
export default function GraphChoiceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}) {
  const t = useT()
  const box = data?.labelBox
  const routedPoints = data?.route?.points
  let edgePath
  let fallbackLabelX = 0
  let fallbackLabelY = 0
  if (routedPoints?.length) {
    const points = applyRouteHandles(routedPoints, sourceX, sourceY, targetX, targetY)
    edgePath = roundedOrthogonalPath(points)
  } else {
    const fallback = graphChoiceBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      parallelSourceOffsetY: data?.parallelSourceOffsetY ?? data?.parallelOffsetY ?? 0,
      parallelTargetOffsetY: data?.parallelTargetOffsetY ?? data?.parallelOffsetY ?? 0,
    })
    edgePath = fallback.path
    fallbackLabelX = fallback.labelX
    fallbackLabelY = fallback.labelY
  }
  const labelStyle = box
    ? {
      boxSizing: 'border-box',
      width: `${box.width || GRAPH_EDGE_LABEL_MAX_WIDTH}px`,
      maxWidth: `${box.width || GRAPH_EDGE_LABEL_MAX_WIDTH}px`,
      height: `${box.height}px`,
      transform: `translate(${box.x}px, ${box.y}px)`,
    }
    : {
      maxWidth: `${GRAPH_EDGE_LABEL_MAX_WIDTH}px`,
      transform: `translate(-50%, -100%) translate(${fallbackLabelX}px, ${fallbackLabelY - GRAPH_EDGE_LABEL_OFFSET_Y}px)`,
    }
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.label && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={[
              'nodrag',
              'nopan',
              'graph-edge-label',
              data.unreachable ? 'unreachable' : '',
              data.selected ? 'selected' : '',
            ].filter(Boolean).join(' ')}
            style={labelStyle}
            data-quickstart={data.quickstartTarget || 'event-edge'}
            title={data.fullLabel}
            onClick={(event) => {
              event.stopPropagation()
              data.onSelect?.()
            }}
          >
            <span>{data.label}</span>
            {data.locked && <span className="graph-edge-lock" aria-label={t('events.network.hasUnlock')}>🔒</span>}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
