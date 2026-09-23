import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useT } from '../i18n'
import { ConceptHelpTrigger } from './ConceptHelpContext'

// 允许的素材后缀与单文件大小上限（与后端 MATERIAL_EXTS 对齐；其它格式暂不支持）。
const ALLOWED_EXTS = ['.md', '.txt', '.json']
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB，避免一次塞入超大文件
const PREVIEW_CHUNK_CHARS = 100000

// 把字节数格式化为人类可读大小。
function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function hasAllowedExt(name) {
  const lower = name.toLowerCase()
  return ALLOWED_EXTS.some((ext) => lower.endsWith(ext))
}

/**
 * 为完整 JSON 素材生成易读缩进；分段内容或非法 JSON 保留原文。
 *
 * @param {{name:string,content:string,complete:boolean}} preview 当前预览。
 * @returns {string} 用于原文区域展示的文本。
 */
function displaySource(preview) {
  if (!preview.name.toLowerCase().endsWith('.json') || !preview.complete) {
    return preview.content
  }
  try {
    return JSON.stringify(JSON.parse(preview.content), null, 2)
  } catch {
    return preview.content
  }
}

/**
 * 素材面板（首个阶段标签）：列出已上传素材 + 上传文件 + 粘贴文本 + 删除。
 *
 * 素材是**可选**的、数量不限，仅支持 .md/.txt/.json 纯文本。点击文件名可
 * 分段读取只读预览；上传和删除仍由父组件统一处理权限与项目锁。
 *
 * @param {{materials: {name:string,size:number}[], disabled:boolean,
 *   onUpload:(filename:string,content:string)=>Promise<void>,
 *   onDelete:(name:string)=>Promise<void>,
 *   onPreview:(name:string,offset:number)=>Promise<object>}} props
 */
export default function MaterialsPanel({
  materials,
  disabled,
  onUpload,
  onDelete,
  onPreview,
}) {
  const t = useT()
  const fileRef = useRef(null)
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewMode, setPreviewMode] = useState('rendered')

  useEffect(() => {
    if (preview && !(materials || []).some((item) => item.name === preview.name)) {
      setPreview(null)
    }
  }, [materials, preview])

  useEffect(() => {
    if (!preview) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  /**
   * 打开一份素材并读取首段；重复点击其它文件会替换当前预览。
   *
   * @param {string} name 素材文件名。
   */
  const openPreview = async (name) => {
    setErr('')
    setPreviewLoading(true)
    setPreviewMode('rendered')
    try {
      setPreview(await onPreview(name, 0))
    } catch (ex) {
      setErr(t('artifacts.materials.previewFailed', { name, detail: ex.message }))
    } finally {
      setPreviewLoading(false)
    }
  }

  /** 读取当前素材的下一段并拼接到已经显示的正文。 */
  const loadMorePreview = async () => {
    if (!preview || preview.complete || previewLoading) return
    setErr('')
    setPreviewLoading(true)
    try {
      const next = await onPreview(preview.name, preview.next_offset)
      setPreview((current) => (
        current?.name === next.name
          ? {
              ...next,
              content: current.content + next.content,
              offset: 0,
            }
          : current
      ))
    } catch (ex) {
      setErr(t('artifacts.materials.loadMoreFailed', { detail: ex.message }))
    } finally {
      setPreviewLoading(false)
    }
  }

  // 选文件 → 校验后缀/大小 → 读为文本 → 上传。支持一次多选。
  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // 允许再次选同名文件
    setErr('')
    for (const file of files) {
      if (!hasAllowedExt(file.name)) {
        setErr(t('artifacts.materials.unsupported', { name: file.name, exts: ALLOWED_EXTS.join(' / ') }))
        continue
      }
      if (file.size > MAX_BYTES) {
        setErr(t('artifacts.materials.tooLarge', { name: file.name, limit: fmtSize(MAX_BYTES) }))
        continue
      }
      try {
        const text = await file.text()
        setWorking(true)
        await onUpload(file.name, text)
      } catch (ex) {
        setErr(t('artifacts.materials.uploadFailed', { name: file.name, detail: ex.message }))
      } finally {
        setWorking(false)
      }
    }
  }

  // 粘贴文本另存为一份 .txt 素材（未填名则自动生成）。
  const savePaste = async () => {
    const text = pasteText.trim()
    if (!text) return
    let name = pasteName.trim()
    if (!name) name = t('artifacts.materials.autoName', { stamp: new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') })
    else if (!hasAllowedExt(name)) name += '.txt'
    setErr('')
    setWorking(true)
    try {
      await onUpload(name, text)
      setPasteName('')
      setPasteText('')
    } catch (ex) {
      setErr(t('artifacts.materials.saveFailed', { detail: ex.message }))
    } finally {
      setWorking(false)
    }
  }

  const list = materials || []

  return (
    <div className="materials" data-quickstart="panel-materials">
      <div className="materials-intro">
        <ConceptHelpTrigger conceptId="materials" />
        {t('artifacts.materials.introBefore')}
        <strong>{t('artifacts.materials.optional')}</strong>
        {t('artifacts.materials.introAfter')}
        <code>.md</code> / <code>.txt</code> / <code>.json</code>
        {t('artifacts.materials.introExts')}
      </div>

      <div className="materials-actions" data-quickstart="materials-upload">
        <button className="btn btn-primary btn-small" disabled={disabled || working} onClick={() => fileRef.current?.click()}>
          {working ? t('common.processing') : t('artifacts.materials.upload')}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".md,.txt,.json,text/markdown,text/plain,application/json"
          style={{ display: 'none' }}
          onChange={onPickFiles}
        />
        <span className="muted">{t('artifacts.materials.multiSelect', { size: fmtSize(MAX_BYTES) })}</span>
      </div>

      {err && <div className="materials-err">{err}</div>}

      <div className="materials-list">
        {list.length === 0 ? (
          <div className="md-empty">{t('artifacts.materials.empty')}</div>
        ) : (
          list.map((m) => (
            <div key={m.name} className="material-row">
              <button
                type="button"
                className="material-name material-preview-link"
                title={t('artifacts.materials.previewNamed', { name: m.name })}
                disabled={previewLoading}
                onClick={() => openPreview(m.name)}
              >
                {m.name}
              </button>
              <span className="material-size">{fmtSize(m.size)}</span>
              <button
                className="btn btn-ghost btn-small"
                disabled={disabled || working}
                onClick={() => onDelete(m.name)}
              >
                {t('common.delete')}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="paste-box">
        <div className="paste-head">{t('artifacts.materials.pasteBox')}</div>
        <input
          className="field-input"
          type="text"
          value={pasteName}
          placeholder={t('artifacts.materials.pasteName')}
          disabled={disabled || working}
          onChange={(e) => setPasteName(e.target.value)}
        />
        <textarea
          className="field-input paste-text"
          rows={6}
          value={pasteText}
          placeholder={t('artifacts.materials.pastePlaceholder')}
          disabled={disabled || working}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <button className="btn btn-primary btn-small" disabled={disabled || working || !pasteText.trim()} onClick={savePaste}>
          {t('artifacts.materials.saveAs')}
        </button>
      </div>

      {preview && (
        <div
          className="material-preview-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null)
          }}
        >
          <aside
            className="material-preview-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t('artifacts.materials.previewTitle', { name: preview.name })}
          >
            <header className="material-preview-head">
              <div>
                <strong>{preview.name}</strong>
                <span>
                  {t('artifacts.materials.loadedChars', {
                    loaded: preview.content.length.toLocaleString(),
                    total: preview.total_chars.toLocaleString(),
                  })}
                </span>
              </div>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setPreview(null)}>
                {t('common.close')}
              </button>
            </header>

            {preview.name.toLowerCase().endsWith('.md') && (
              <div className="material-preview-modes" role="tablist" aria-label={t('artifacts.materials.markdownMode')}>
                <button
                  type="button"
                  className={previewMode === 'rendered' ? 'active' : ''}
                  onClick={() => setPreviewMode('rendered')}
                >
                  {t('artifacts.materials.rendered')}
                </button>
                <button
                  type="button"
                  className={previewMode === 'source' ? 'active' : ''}
                  onClick={() => setPreviewMode('source')}
                >
                  {t('artifacts.materials.source')}
                </button>
              </div>
            )}

            <div className="material-preview-content">
              {preview.name.toLowerCase().endsWith('.md') && previewMode === 'rendered'
                ? <ReactMarkdown>{preview.content}</ReactMarkdown>
                : <pre>{displaySource(preview)}</pre>}
            </div>

            {!preview.complete && (
              <footer className="material-preview-footer">
                <span>{t('artifacts.materials.truncated')}</span>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={previewLoading}
                  onClick={loadMorePreview}
                >
                  {previewLoading
                    ? t('artifacts.materials.loading')
                    : t('artifacts.materials.loadMore', { count: PREVIEW_CHUNK_CHARS.toLocaleString() })}
                </button>
              </footer>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
