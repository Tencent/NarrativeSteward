import { useT } from '../i18n'
import { ConceptHelpTrigger } from './ConceptHelpContext'

/**
 * 渲染片段编辑器统一的还原与保存操作。
 *
 * @param {object} props 操作状态与回调。
 * @param {boolean} props.dirty 草稿是否有未保存修改。
 * @param {boolean} props.disabled 当前编辑器是否只读。
 * @param {boolean} props.saving 是否正在保存。
 * @param {Function} props.onSave 保存当前草稿。
 * @param {Function} props.onReset 还原当前草稿。
 */
function FragmentActions({ dirty, disabled, saving, onSave, onReset }) {
  const t = useT()
  return (
    <div className="fragment-actions" data-quickstart="save">
      {dirty && !disabled && (
        <button type="button" className="btn btn-ghost" onClick={onReset} disabled={saving}>
          {t('common.restore')}
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary"
        onClick={onSave}
        disabled={disabled || saving || !dirty}
      >
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  )
}

/**
 * 片段编辑器外壳：统一标题、版本状态和保存操作，内容由 children 提供。
 *
 * @param {object} props 编辑器展示和操作属性。
 * @param {boolean} props.stickyActions 为 true 时把头部及操作固定在长表单顶部。
 * @param {boolean} props.compactHeader 为 true 时隐藏重复标题，只保留版本、草稿状态和操作。
 * @param {string} [props.conceptId] 标题旁的永久概念问号。
 */
export default function FragmentShell({
  title,
  conceptId,
  hint,
  revision,
  stage,
  dirty = false,
  disabled = false,
  saving = false,
  stickyActions = false,
  compactHeader = false,
  onSave,
  onReset,
  children,
}) {
  const t = useT()
  return (
    <section className={`card fragment-shell${stickyActions ? ' fragment-shell-sticky-actions' : ''}${compactHeader ? ' fragment-shell-compact' : ''}`}>
      <header className="card-head">
        {!compactHeader && (
          <div className="card-title-wrap">
            <h3 className="card-title">
              {title}
              {conceptId && <ConceptHelpTrigger conceptId={conceptId} />}
            </h3>
            {hint && <span className="muted">{hint}</span>}
          </div>
        )}
        <div className="fragment-shell-head-meta">
          <div className="card-badges">
            {dirty && <span className="badge badge-dirty">{t('workspace.tabs.unsaved')}</span>}
            {typeof revision === 'number' && <span className="badge">r{revision}</span>}
            {stage && <span className={`badge badge-stage badge-${stage}`}>{stage}</span>}
          </div>
          {stickyActions && (
            <FragmentActions
              dirty={dirty}
              disabled={disabled}
              saving={saving}
              onSave={onSave}
              onReset={onReset}
            />
          )}
        </div>
      </header>

      <div className="card-body">{children}</div>

      {!stickyActions && (
        <footer className="card-foot">
          <FragmentActions
            dirty={dirty}
            disabled={disabled}
            saving={saving}
            onSave={onSave}
            onReset={onReset}
          />
        </footer>
      )}
    </section>
  )
}
