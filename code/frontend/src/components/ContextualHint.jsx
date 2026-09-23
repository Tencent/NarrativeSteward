/**
 * 情境化首次提示：在真实项目里第一次进入对应情境时显示。
 * 「知道了」和「了解更多」都先记下已看过；后者再打开同一条概念说明。
 */
import { useT } from '../i18n'
import { getContextualHint } from '../onboarding/contextualHints'

/**
 * @param {object} props
 * @param {null | { id: string, title?: string, body?: string, conceptId?: string }} props.hint
 * @param {() => void} props.onDismiss
 * @param {(conceptId: string) => void} [props.onLearnMore]
 */
export default function ContextualHint({ hint, onDismiss, onLearnMore }) {
  const t = useT()
  if (!hint) return null
  const definition = hint.id ? getContextualHint(hint.id) : null
  const conceptId = hint.conceptId || definition?.conceptId || null
  const title = hint.id ? t(`help.hints.${hint.id}.title`) : hint.title
  const body = hint.id ? t(`help.hints.${hint.id}.body`) : hint.body
  return (
    <aside className="contextual-hint" role="status">
      <div className="contextual-hint-copy">
        <strong>{title.startsWith('help.hints.') ? hint.title : title}</strong>
        <p>{body.startsWith('help.hints.') ? hint.body : body}</p>
      </div>
      <div className="contextual-hint-actions">
        {conceptId && onLearnMore && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onLearnMore(conceptId)}
          >
            {t('help.center.learnMore')}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          {t('common.gotIt')}
        </button>
      </div>
    </aside>
  )
}
