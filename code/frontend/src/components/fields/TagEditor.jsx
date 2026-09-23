import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'

/**
 * 标签编辑原子件：一组字符串（如 traits / allowed / characters）可增删。
 *
 * 添加交互（c0.31 起）：不再常驻一个大输入框，而是标签行末一个小 `+` 片；点击就地
 * 变成迷你输入框，回车 / 失焦提交、Esc 取消，随后复位为 `+`。节省纵向空间、观感更轻。
 *
 * @param {string} [label]
 * @param {string[]} tags
 * @param {(tags:string[])=>void} onChange
 * @param {boolean} [disabled]
 * @param {string} [placeholder] 迷你输入框的占位符
 */
export default function TagEditor({ label, tags = [], onChange, disabled = false, placeholder }) {
  const t = useT()
  const addPlaceholder = placeholder ?? t('artifacts.tags.placeholder')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  // 进入添加态时自动聚焦迷你输入框。
  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  // 提交当前输入：非空则追加为新标签，随后复位为 `+`。
  const commit = () => {
    const tag = draft.trim()
    if (tag) onChange([...tags, tag])
    setDraft('')
    setAdding(false)
  }
  const cancel = () => {
    setDraft('')
    setAdding(false)
  }
  const remove = (i) => onChange(tags.filter((_, idx) => idx !== i))

  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      <div className="tag-list">
        {tags.map((tag, i) => (
          <span className="tag" key={i}>
            {tag}
            {!disabled && (
              <button type="button" className="tag-remove" onClick={() => remove(i)} aria-label={t('common.delete')}>
                ×
              </button>
            )}
          </span>
        ))}

        {!disabled && !adding && (
          <button
            type="button"
            className="tag-add-chip"
            onClick={() => setAdding(true)}
            aria-label={t('artifacts.tags.add')}
            title={t('artifacts.tags.add')}
          >
            +
          </button>
        )}
        {!disabled && adding && (
          <input
            ref={inputRef}
            className="tag-add-input"
            type="text"
            value={draft}
            placeholder={addPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
          />
        )}

        {tags.length === 0 && disabled && <span className="tag-empty">{t('artifacts.tags.empty')}</span>}
      </div>
    </div>
  )
}
