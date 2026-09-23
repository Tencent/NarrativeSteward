import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import {
  assetOperationActions,
  resolveAssetFileAction,
  resolveAssetGenerateAction,
} from '../../assetOperation'
import { useT } from '../../i18n'
import Drawer from '../Drawer'
import TextFieldRow from './TextFieldRow'
import TagEditor from './TagEditor'

/** 快速上手用来示意「点新增后」的空白卡，不写入项目。 */
const QUICKSTART_NEW_CARD_ID = '__quickstart-new-card__'
const EMPTY_PREVIEW_CARD = { id: '', name: '', description: '', tags: [], image: '' }

/**
 * 按是否处于检查点预览决定配图地址：预览走冻结代次，正式内容走 assets/。
 * @param {string} [projectId]
 * @param {string} [image]
 * @param {{projectId?: string, turnId: string, generation: number}|null} [previewAsset]
 * @returns {string}
 */
function resolveCardImageUrl(projectId, image, previewAsset) {
  if (!image) return ''
  if (previewAsset?.turnId != null && previewAsset?.generation != null) {
    return api.previewAssetUrl(
      previewAsset.projectId || projectId,
      previewAsset.turnId,
      previewAsset.generation,
      image,
    )
  }
  return api.assetUrl(projectId, image)
}

/**
 * 配图读取失败时只显示占位，不反向清空卡片文字。
 */
function CardImage({ src, className, alt, placeholder = null }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  if (!src || failed) return placeholder
  return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />
}

/**
 * 卡片网格编辑件：把一组同构对象（如某类设定卡片）渲染成一排排折叠卡片，
 * 点击卡片打开右侧抽屉编辑详情（按 fields schema）+ 删除；末尾有"新增"卡片。
 *
 * 编辑作用于内存 draft（经 onChange 冒泡给上层），真正落盘由上层统一"保存"负责——
 * 与字段级表单一致的"整份一次保存 + 乐观锁"模型（见 DESIGN §5.7）。
 *
 * @param {string} label 该类卡片的名称（用于按钮/抽屉标题，如"角色"）
 * @param {object[]} items 卡片列表
 * @param {{key:string,label:string,type:'text'|'textarea'|'tags',rows?:number}[]} fields 字段 schema
 * @param {()=>object} newItem 新建空白卡片的工厂
 * @param {(items:object[])=>void} onChange
 * @param {boolean} [disabled]
 * @param {string} [titleKey] 卡片标题字段名（默认 name）
 * @param {boolean} [withImage] 是否支持卡片配图（角色/地点用；见 DESIGN §5.8）
 * @param {string} [projectId] 项目 id（配图上传 / 预览取 URL 用，withImage 时必传）
 * @param {{projectId?: string, turnId: string, generation: number}|null} [previewAsset] 检查点配图上下文。
 * @param {'characters'|'locations'} [category] 当前卡片分类（生图时必传）
 * @param {string|null} [focusItemId] 外部定位要打开的稳定卡片 id。
 * @param {number} [focusSeq] 重复定位同一卡片时递增的序号。
 * @param {(operation: object|null) => void} [onAssetOperationChange] 配图上传/生图开始或结束时上报全局状态。
 * @param {(focus: {kind: string, id?: string|null, category?: string|null}|null) => void} [onInspectorChange]
 *   真实抽屉打开、关闭或删除卡片时上报；六类设定卡统一为 world-card。
 */
export default function CardGrid({
  label,
  items = [],
  fields,
  newItem,
  onChange,
  disabled = false,
  titleKey = 'name',
  withImage = false,
  projectId,
  previewAsset = null,
  category,
  focusItemId,
  focusSeq,
  onAssetOperationChange,
  onInspectorChange,
}) {
  const t = useT()
  // 当前在抽屉中编辑的卡片下标（null 表示抽屉关闭）。
  const [openIndex, setOpenIndex] = useState(null)
  const [previewNewCard, setPreviewNewCard] = useState(false)
  useEffect(() => {
    if (!focusSeq) return
    if (focusItemId === QUICKSTART_NEW_CARD_ID) {
      setPreviewNewCard(true)
      setOpenIndex(null)
      return
    }
    setPreviewNewCard(false)
    if (!focusItemId) {
      setOpenIndex(null)
      return
    }
    const index = items.findIndex((item) => item.id === focusItemId)
    setOpenIndex(index >= 0 ? index : null)
  }, [focusSeq, focusItemId, items])

  const update = (i, key, val) => onChange(items.map((it, idx) => (idx === i ? { ...it, [key]: val } : it)))
  const remove = (i) => {
    onChange(items.filter((_, idx) => idx !== i))
    setOpenIndex(null)
  }
  const add = () => {
    if (disabled) return
    onChange([...items, newItem()])
    setOpenIndex(items.length) // 新卡片追加在末尾，直接打开编辑
  }

  const descField = fields.find((f) => f.key === 'description')
  const current = previewNewCard
    ? EMPTY_PREVIEW_CARD
    : (openIndex != null ? items[openIndex] : null)

  useEffect(() => {
    if (openIndex != null && !items[openIndex]) setOpenIndex(null)
  }, [items, openIndex])

  // 快速上手的空白预览卡不计入真实检查器；关闭或删除后清空。
  useEffect(() => {
    if (previewNewCard || current == null) {
      onInspectorChange?.(null)
      return undefined
    }
    onInspectorChange?.({
      kind: 'world-card',
      id: current.id || null,
      category: category || null,
    })
    return () => onInspectorChange?.(null)
  }, [previewNewCard, current, category, onInspectorChange])

  return (
    <div className="cardgrid-wrap" data-quickstart="world-cards">
      <div className="cardgrid">
        {items.map((item, i) => (
          <button type="button" className="card" key={i} onClick={() => setOpenIndex(i)}>
            {withImage && item.image && (
              <CardImage className="card-thumb" src={resolveCardImageUrl(projectId, item.image, previewAsset)} alt="" />
            )}
            <div className="card-title">{(titleKey && item[titleKey]) || `#${i + 1}`}</div>
            {descField && item[descField.key] && <div className="card-desc">{item[descField.key]}</div>}
            {Array.isArray(item.tags) && item.tags.length > 0 && (
              <div className="card-tags">
                {item.tags.slice(0, 6).map((t, k) => (
                  <span className="tag tag-mini" key={k}>
                    {t}
                  </span>
                ))}
                {item.tags.length > 6 && <span className="tag tag-mini muted">+{item.tags.length - 6}</span>}
              </div>
            )}
          </button>
        ))}
        <button
          type="button"
          className="card card-add"
          data-quickstart="world-add-card"
          onClick={add}
          disabled={disabled}
        >
          + {t('artifacts.world.addCard', { label })}
        </button>
      </div>

      {items.length === 0 && disabled && <div className="objlist-empty">{t('artifacts.world.emptyCategory', { label })}</div>}

      <Drawer
        open={current != null}
        title={previewNewCard ? t('artifacts.world.addCard', { label }) : t('artifacts.world.editCard', { label })}
        onClose={() => {
          setPreviewNewCard(false)
          setOpenIndex(null)
        }}
        footer={
          !disabled && current != null && !previewNewCard ? (
            <button type="button" className="btn btn-small btn-danger" onClick={() => remove(openIndex)}>
              {t('artifacts.world.deleteCard')}
            </button>
          ) : null
        }
      >
        {current != null && withImage && (
          <ImageField
            projectId={projectId}
            previewAsset={previewAsset}
            category={category}
            card={current}
            image={current.image}
            disabled={disabled || previewNewCard}
            onAssetOperationChange={onAssetOperationChange}
            onChange={(v) => {
              if (previewNewCard || openIndex == null) return
              update(openIndex, 'image', v)
            }}
          />
        )}
        {current != null &&
          fields.map((f) =>
            f.type === 'tags' ? (
              <TagEditor
                key={f.key}
                label={f.label}
                tags={current[f.key] || []}
                disabled={disabled || previewNewCard}
                onChange={(v) => {
                  if (previewNewCard || openIndex == null) return
                  update(openIndex, f.key, v)
                }}
              />
            ) : (
              <TextFieldRow
                key={f.key}
                label={f.label}
                value={current[f.key]}
                multiline={f.type === 'textarea'}
                rows={f.rows}
                disabled={disabled || previewNewCard}
                onChange={(v) => {
                  if (previewNewCard || openIndex == null) return
                  update(openIndex, f.key, v)
                }}
              />
            ),
          )}
      </Drawer>
    </div>
  )
}

/**
 * 卡片配图编辑块（抽屉内）：预览、上传、AI 生图和移除。
 * 上传或生图成功后都把返回的相对路径（"assets/<name>"）经 onChange 写进卡片 draft，
 * 用户再随 world 统一保存，避免生图时刷新服务端 world 覆盖其它未保存字段。
 *
 * @param {string} projectId
 * @param {'characters'|'locations'} category
 * @param {object} card 当前卡片草稿（名称、描述、标签用于构建生图提示词）
 * @param {string} image 卡片当前配图相对路径（可空）
 * @param {boolean} disabled
 * @param {(operation: object|null) => void} [onAssetOperationChange]
 * @param {(v:string)=>void} onChange
 */
function ImageField({
  projectId,
  previewAsset = null,
  category,
  card,
  image,
  disabled,
  onAssetOperationChange,
  onChange,
}) {
  const t = useT()
  const inputRef = useRef(null)
  const [busyAction, setBusyAction] = useState(null)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)

  const beginOperation = (action) => {
    setBusyAction(action)
    setErr(null)
    setNote(null)
    onAssetOperationChange?.({
      projectId,
      category,
      cardName: card?.name || '',
      action,
      startedAt: Date.now(),
    })
  }

  const endOperation = () => {
    setBusyAction(null)
    onAssetOperationChange?.(null)
  }

  const pick = () => inputRef.current?.click()
  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选同名文件
    if (!file) return
    beginOperation(resolveAssetFileAction(Boolean(image)))
    try {
      const res = await api.uploadAsset(projectId, file)
      onChange(res.path)
    } catch (ex) {
      setErr(ex.message || t('artifacts.world.uploadFailed'))
    } finally {
      endOperation()
    }
  }

  const generate = async () => {
    if (!card?.name?.trim()) {
      setErr(t('artifacts.world.needName'))
      return
    }
    if (image && !window.confirm(t('artifacts.world.confirmReplace'))) return
    beginOperation(resolveAssetGenerateAction(Boolean(image)))
    try {
      const res = await api.generateCardImage(projectId, {
        category,
        name: card.name,
        description: card.description,
        tags: card.tags,
      })
      onChange(res.path)
      setNote(t('artifacts.world.generated'))
    } catch (ex) {
      setErr(ex.message || t('artifacts.world.generateFailed'))
    } finally {
      endOperation()
    }
  }

  const busy = busyAction != null
  const actions = assetOperationActions(t)
  const fileAction = resolveAssetFileAction(Boolean(image))
  const generateAction = resolveAssetGenerateAction(Boolean(image))
  const fileBusy = busyAction === 'upload' || busyAction === 'replace'
  const generateBusy = busyAction === 'generate' || busyAction === 'regenerate'
  return (
    <div className="field card-image-field">
      <span className="field-label">{t('artifacts.world.imageField')}</span>
      {image ? (
        <CardImage
          className="card-image-preview"
          src={resolveCardImageUrl(projectId, image, previewAsset)}
          alt={t('artifacts.world.imagePreview')}
          placeholder={<div className="card-image-empty muted">{t('artifacts.world.imageUnavailable')}</div>}
        />
      ) : (
        <div className="card-image-empty muted">{t('artifacts.world.noImage')}</div>
      )}
      <div className="card-image-actions" data-quickstart="world-card-image">
        <button type="button" className="btn btn-small" onClick={pick} disabled={disabled || busy}>
          {fileBusy
            ? actions[busyAction].buttonBusy
            : actions[fileAction].buttonIdle}
        </button>
        {image && (
          <button
            type="button"
            className="btn btn-small btn-danger"
            onClick={() => onChange('')}
            disabled={disabled || busy}
          >
            {t('artifacts.world.removeImage')}
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={generate} disabled={disabled || busy}>
          {generateBusy
            ? actions[busyAction].buttonBusy
            : actions[generateAction].buttonIdle}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={onFile}
        />
      </div>
      {note && <div className="muted">{note}</div>}
      {err && <div className="banner banner-inline" onClick={() => setErr(null)}>{err}{t('common.clickToDismiss')}</div>}
    </div>
  )
}
