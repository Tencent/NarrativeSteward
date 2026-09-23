import { useEffect, useState } from 'react'
import { useDraft } from '../hooks/useDraft'
import { useT } from '../i18n'
import { WORLD_CARD_CATEGORIES, WORLD_IMAGE_CATEGORIES } from '../worldCardReferences'
import FragmentShell from './FragmentShell'
import CardGrid from './fields/CardGrid'

// 缺字段时补齐为空数组，便于字段级编辑。与 speaker 解析共用六类键。
const DEFAULT = Object.fromEntries(WORLD_CARD_CATEGORIES.map((c) => [c.key, []]))

// 可编辑的卡片字段（名称 / 描述 / 标签）。
// 注意：``id`` 是供后续事件层引用的稳定标识，对用户**不可见、不可编辑**——故不列入此处；
// 但它仍随卡片对象保留在 draft 中（Agent 写入的 id 不会丢）。
/** 六类设定卡片对应的字典 key（worldview / characters 等是运行时分类 id，不翻译）。 */
const CARD_LABEL_KEYS = {
  worldview: 'artifacts.cards.worldview',
  characters: 'artifacts.cards.character',
  locations: 'artifacts.cards.location',
  factions: 'artifacts.cards.faction',
  history: 'artifacts.cards.history',
  other: 'artifacts.cards.other',
}

const newCard = () => ({ id: '', name: '', description: '', tags: [], image: '' })

const OBJECT_CATEGORY = {
  worldview: 'worldview',
  character: 'characters',
  location: 'locations',
  faction: 'factions',
  history: 'history',
  other: 'other',
}

// 世界设定字段级表单（world.json）：按子类型分内层 sub-tab，每类是一排卡片网格（见 DESIGN §5.7）。
export default function WorldForm({
  fragment,
  projectId,
  previewAsset = null,
  disabled,
  onSave,
  onDirtyChange,
  focusObjectType,
  focusObjectId,
  focusSeq,
  onAssetOperationChange,
  // 当前类别的真实抽屉打开/关闭时上报；六类卡片统一为 world-card。
  onInspectorChange,
}) {
  const t = useT()
  const cardFields = [
    { key: 'name', label: t('artifacts.world.name'), type: 'text' },
    { key: 'description', label: t('artifacts.world.description'), type: 'textarea', rows: 3 },
    { key: 'tags', label: t('artifacts.world.tags'), type: 'tags' },
  ]
  const value = { ...DEFAULT, ...(fragment?.content || {}) }
  const [draft, setDraft, dirty, reset] = useDraft(value, fragment?.revision)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [cat, setCat] = useState(WORLD_CARD_CATEGORIES[0].key) // 当前查看的子类型 tab

  // 把 dirty 状态上报给父组件（用于阶段标签上的提示圆点）。
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    const targetCategory = OBJECT_CATEGORY[focusObjectType]
    if (focusSeq && targetCategory) setCat(targetCategory)
  }, [focusSeq, focusObjectType])

  // 只读禁止编辑/保存；二级分类仍可切换浏览（见 DESIGN §5.8 / §6.7）。
  const set = (key, val) => setDraft({ ...draft, [key]: val })
  const save = async () => {
    setSaving(true)
    setSaveError('')
    try {
      await onSave(draft)
    } catch (err) {
      setSaveError(err?.message || t('artifacts.world.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <FragmentShell
      title={t('artifacts.world.title')}
      conceptId="worldCard"
      hint={t('artifacts.world.hint')}
      revision={fragment?.revision}
      stage={fragment?.stage}
      dirty={dirty}
      disabled={disabled}
      saving={saving}
      onSave={save}
      onReset={reset}
    >
      {saveError && (
        <p className="error-text" style={{ whiteSpace: 'pre-wrap' }}>{saveError}</p>
      )}
      <div className="subtabs">
        {WORLD_CARD_CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`subtab ${cat === c.key ? 'active' : ''}`}
            data-quickstart={`world-cat-${c.key}`}
            onClick={() => setCat(c.key)}
          >
            {t(CARD_LABEL_KEYS[c.key] || 'artifacts.cards.other')} <span className="muted">{(draft[c.key] || []).length}</span>
          </button>
        ))}
      </div>
      <CardGrid
        key={cat}
        label={t(CARD_LABEL_KEYS[cat] || 'artifacts.cards.other')}
        items={draft[cat] || []}
        fields={cardFields}
        titleKey="name"
        newItem={newCard}
        disabled={disabled}
        withImage={WORLD_IMAGE_CATEGORIES.has(cat)}
        projectId={projectId}
        previewAsset={previewAsset}
        category={cat}
        focusItemId={focusObjectId}
        focusSeq={focusSeq}
        onAssetOperationChange={onAssetOperationChange}
        onInspectorChange={onInspectorChange}
        onChange={(v) => set(cat, v)}
      />
    </FragmentShell>
  )
}
