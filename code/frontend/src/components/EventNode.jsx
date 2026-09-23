import { Handle, Position } from '@xyflow/react'
import { useT } from '../i18n'

// 事件图自定义节点（见 DESIGN §5.7）：圆角矩形，显示事件名 + 类型角标 + 情节状态点。
// 布局为左→右（rankdir=LR），故连接柄放左右两侧。预留缩略图位（future）。

export default function EventNode({ data }) {
  const t = useT()
  const {
    eventId,
    title,
    kind = 'mainline',
    sceneStatus = 'empty',
    onOpenDetail,
  } = data
  const typeKey = {
    mainline: 'events.types.mainline',
    optional: 'events.types.optional',
    ending: 'events.types.ending',
  }[kind]
  const sceneKey = sceneStatus === 'ready'
    ? 'events.network.sceneReady'
    : 'events.network.sceneMissing'
  return (
    <div
      className={`eg-node eg-node-${kind}`}
      data-quickstart={eventId ? `event-node-${eventId}` : undefined}
      onDoubleClick={(event) => {
        // 阻止双击继续冒泡到画布，避免打开事件检查器的同时触发视口缩放。
        event.stopPropagation()
        onOpenDetail?.()
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="eg-node-head">
        <span className={`eg-node-type eg-node-type-${kind}`}>{typeKey ? t(typeKey) : kind}</span>
        <span className={`eg-scene-dot eg-scene-${sceneStatus}`} title={t(sceneKey)} />
      </div>
      <div className="eg-node-title" title={title}>
        {title}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
