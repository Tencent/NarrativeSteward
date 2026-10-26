import { useState } from 'react'
import { useLocale } from '../i18n'

export default function ExportProjectButton({ projectId, disabled = false }) {
  const { locale } = useLocale()
  const en = locale === 'en-US'
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function download() {
    setPending(true)
    setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${response.status}`)
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'NarrativeSteward-project.zip'
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (err) {
      setError(err.message)
    } finally {
      setPending(false)
    }
  }
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    <button type="button" className="btn btn-ghost btn-small" data-testid="export-project"
      disabled={disabled || pending} onClick={download}
      title={en ? 'Export saved story and images with an offline HTML player. Save edits first.' : '导出已保存的故事、配图和离线 HTML 播放器。请先保存修改。'}>
      {pending ? (en ? 'Exporting…' : '正在导出…') : (en ? 'Export project' : '导出项目')}
    </button>
    {error && <span role="alert" style={{ color: '#b42318', maxWidth: 320 }}>{error}</span>}
  </span>
}
