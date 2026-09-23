/**
 * 应用内概念帮助中心：可搜索、按分类浏览、打开指定概念。
 * 关闭后不切换板块；「去当前界面查看」由 App 按注册表安全目的地执行。
 */

import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import {
  canNavigateConcept,
  getConcept,
  groupConceptsByCategory,
  relatedConcepts,
  searchConcepts,
} from '../onboarding/concepts'

/**
 * 正文里的一段说明。
 * @param {string} label
 * @param {string} text
 */
function HelpBlock({ label, text }) {
  if (!text || text.startsWith('help.concept.')) return null
  return (
    <div className="concept-help-block">
      <h4>{label}</h4>
      <p>{text}</p>
    </div>
  )
}

/**
 * @param {object} props
 * @param {string | null} [props.initialConceptId]
 * @param {(conceptId: string | null) => void} [props.onConceptChange]
 * @param {(destination: object) => void} [props.onNavigate]
 * @param {object} [props.navigationContext]
 */
export default function ConceptHelpPanel({
  initialConceptId = null,
  onConceptChange,
  onNavigate,
  navigationContext = {},
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(() => (
    getConcept(initialConceptId) ? initialConceptId : null
  ))

  useEffect(() => {
    setSelectedId(getConcept(initialConceptId) ? initialConceptId : null)
    setQuery('')
  }, [initialConceptId])

  const results = useMemo(() => searchConcepts(query, t), [query, t])
  const groups = useMemo(() => groupConceptsByCategory(results), [results])
  const selected = getConcept(selectedId)
  const related = selected ? relatedConcepts(selected.id) : []
  const navigation = selected
    ? canNavigateConcept({ conceptId: selected.id, ...navigationContext })
    : { allowed: false, reason: 'none', destination: null }

  const selectConcept = (conceptId) => {
    const next = getConcept(conceptId) ? conceptId : null
    setSelectedId(next)
    onConceptChange?.(next)
  }

  return (
    <section className="concept-help-center">
      <div className="concept-help-nav">
        <label className="concept-help-search">
          <span className="sr-only">{t('help.center.search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('help.center.searchPlaceholder')}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedId(null)
              onConceptChange?.(null)
            }}
          />
        </label>
        {groups.length === 0 ? (
          <p className="concept-help-empty">{t('help.center.empty')}</p>
        ) : (
          <nav className="concept-help-groups" aria-label={t('help.center.overview')}>
            {groups.map((group) => (
              <div key={group.id} className="concept-help-group">
                <h3>{t(`help.center.categories.${group.id}`)}</h3>
                <ul>
                  {group.concepts.map((concept) => {
                    const term = t(`help.concept.${concept.id}.term`)
                    return (
                      <li key={concept.id}>
                        <button
                          type="button"
                          className={selectedId === concept.id ? 'is-active' : ''}
                          onClick={() => selectConcept(concept.id)}
                        >
                          {term.startsWith('help.concept.') ? concept.id : term}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        )}
      </div>
      <div className="concept-help-detail">
        {!selected ? (
          <p className="muted">{t('help.center.overview')}</p>
        ) : (
          <>
            <h3>{t(`help.concept.${selected.id}.term`)}</h3>
            <p className="concept-help-summary">{t(`help.concept.${selected.id}.summary`)}</p>
            <HelpBlock label={t('help.center.why')} text={t(`help.concept.${selected.id}.why`)} />
            <HelpBlock label={t('help.center.example')} text={t(`help.concept.${selected.id}.example`)} />
            <HelpBlock label={t('help.center.where')} text={t(`help.concept.${selected.id}.where`)} />
            <HelpBlock label={t('help.center.caution')} text={t(`help.concept.${selected.id}.caution`)} />
            {related.length > 0 && (
              <div className="concept-help-related">
                <h4>{t('help.center.related')}</h4>
                <div className="concept-help-related-list">
                  {related.map((concept) => (
                    <button
                      type="button"
                      className="btn ghost btn-small"
                      key={concept.id}
                      onClick={() => selectConcept(concept.id)}
                    >
                      {t(`help.concept.${concept.id}.term`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {navigation.reason !== 'none' && (
              <div className="concept-help-go">
                {navigation.allowed ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onNavigate?.(navigation.destination)}
                  >
                    {t('help.center.goToView')}
                  </button>
                ) : (
                  <p className="muted">
                    {navigation.reason === 'dirty'
                      ? t('workspace.chrome.dirtyBeforeNavigate')
                      : navigation.reason === 'demo'
                        ? t('help.center.goDisabledDemo')
                        : t('help.center.goDisabledUnavailable')}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export { ConceptHelpButton, ConceptHelpTrigger } from './ConceptHelpContext'
