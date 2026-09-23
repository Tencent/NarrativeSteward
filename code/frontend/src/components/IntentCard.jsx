import { useEffect, useState } from 'react'
import { useDraft } from '../hooks/useDraft'
import { useT } from '../i18n'
import FragmentShell from './FragmentShell'
import TextFieldRow from './fields/TextFieldRow'

// 创作意图卡片：自由文本（intent.md），项目的"北极星"。
export default function IntentCard({ fragment, disabled, onSave, onDirtyChange }) {
  const t = useT()
  const content = fragment?.content || ''
  const [draft, setDraft, dirty, reset] = useDraft(content, fragment?.revision)
  const [saving, setSaving] = useState(false)

  // 把 dirty 状态上报给父组件（用于阶段标签上的提示圆点）。
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FragmentShell
      title={t('artifacts.intent.title')}
      conceptId="intent"
      hint={t('artifacts.intent.hint')}
      revision={fragment?.revision}
      stage={fragment?.stage}
      dirty={dirty}
      disabled={disabled}
      saving={saving}
      onSave={save}
      onReset={reset}
    >
      <TextFieldRow
        value={draft}
        multiline
        rows={6}
        disabled={disabled}
        placeholder={t('artifacts.intent.placeholder')}
        onChange={setDraft}
      />
    </FragmentShell>
  )
}
