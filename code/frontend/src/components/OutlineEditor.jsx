import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useDraft } from '../hooks/useDraft'
import { useT } from '../i18n'
import FragmentShell from './FragmentShell'

// 故事大纲编辑器：自由 Markdown 文本。
// 默认**预览态**（react-markdown 渲染）+ "编辑"按钮 → 编辑态（textarea）+ "预览"按钮切回。
export default function OutlineEditor({ fragment, disabled, onSave, onDirtyChange }) {
  const t = useT()
  const content = fragment?.content || ''
  const [draft, setDraft, dirty, reset] = useDraft(content, fragment?.revision)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)

  // 把 dirty 状态上报给父组件（用于阶段标签上的提示圆点）。
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 项目处于只读（Agent 回合）时强制回到预览态。
  useEffect(() => {
    if (disabled) setEditing(false)
  }, [disabled])

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FragmentShell
      title={t('artifacts.outline.title')}
      conceptId="outline"
      hint={t('artifacts.outline.hint')}
      revision={fragment?.revision}
      stage={fragment?.stage}
      dirty={dirty}
      disabled={disabled}
      saving={saving}
      onSave={save}
      onReset={reset}
    >
      <div className="md-toolbar">
        <div className="md-tabs">
          <button
            type="button"
            className={`btn btn-small ${!editing ? 'btn-primary' : ''}`}
            onClick={() => setEditing(false)}
          >
            {t('common.preview')}
          </button>
          <button
            type="button"
            className={`btn btn-small ${editing ? 'btn-primary' : ''}`}
            onClick={() => setEditing(true)}
            disabled={disabled}
          >
            {t('common.edit')}
          </button>
        </div>
      </div>

      {editing ? (
        <textarea
          className="field-input md-editor"
          value={draft}
          rows={20}
          disabled={disabled}
          placeholder={t('artifacts.outline.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : draft.trim() ? (
        <div className="markdown-body">
          <ReactMarkdown>{draft}</ReactMarkdown>
        </div>
      ) : (
        <div className="md-empty">{t('artifacts.outline.empty')}</div>
      )}
    </FragmentShell>
  )
}
