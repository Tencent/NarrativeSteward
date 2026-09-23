import { Handle, Position } from '@xyflow/react'
import { useT } from '../i18n'

// 情节图自定义 beat 节点（见 DESIGN §5.7(2)）：类型角标 + 说话人 + 正文截断。
// 布局左→右（rankdir=LR），连接柄放左右两侧。选中态加高亮边框。

export default function SceneBeatNode({ id, data, selected }) {
  const t = useT()
  const { kind = 'narration', speaker, content } = data
  const kindKey = {
    narration: 'events.types.narration',
    monologue: 'events.types.monologueShort',
    dialogue: 'events.types.dialogue',
    choice: 'events.types.choiceShort',
  }[kind]
  return (
    <div
      className={`sb-node sb-node-${kind}${selected ? ' sb-node-selected' : ''}`}
      data-quickstart={id ? `scene-beat-${id}` : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="sb-node-head">
        <span className={`sb-kind sb-kind-${kind}`}>{kindKey ? t(kindKey) : kind}</span>
        {speaker ? <span className="sb-speaker">{speaker}</span> : null}
      </div>
      <div className="sb-node-content" title={content}>
        {content || <span className="muted">{t('events.scene.emptyContent')}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
