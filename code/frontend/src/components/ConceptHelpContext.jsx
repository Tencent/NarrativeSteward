/**
 * 概念帮助的打开入口：全局问号与局部问号共用同一回调，避免把 props 传到每个表单。
 * 局部入口不读取 seen，永远可点。
 */

import { createContext, useContext, useMemo } from 'react'
import { useT } from '../i18n'
import { getConcept } from '../onboarding/concepts'

const ConceptHelpContext = createContext({
  openConceptHelp: () => {},
  closeConceptHelp: () => {},
})

/**
 * @param {object} props
 * @param {(conceptId: string | null) => void} props.onOpen
 * @param {() => void} [props.onClose]
 * @param {import('react').ReactNode} props.children
 */
export function ConceptHelpProvider({ onOpen, onClose, children }) {
  const value = useMemo(() => ({
    openConceptHelp: (conceptId) => onOpen?.(conceptId || null),
    closeConceptHelp: () => onClose?.(),
  }), [onClose, onOpen])
  return (
    <ConceptHelpContext.Provider value={value}>
      {children}
    </ConceptHelpContext.Provider>
  )
}

/**
 * @returns {{ openConceptHelp: Function, closeConceptHelp: Function }}
 */
export function useConceptHelp() {
  return useContext(ConceptHelpContext)
}

/**
 * 中间顶栏的概念说明问号按钮。
 *
 * @returns {JSX.Element}
 */
export function ConceptHelpButton() {
  const t = useT()
  const { openConceptHelp } = useConceptHelp()
  return (
    <button
      type="button"
      className="concept-help-trigger"
      data-quickstart="concept-help"
      aria-label={t('workspace.chrome.conceptHelp')}
      title={t('workspace.chrome.conceptHelp')}
      onClick={() => openConceptHelp(null)}
    >
      ?
    </button>
  )
}

/**
 * 领域标题旁的紧凑问号：永远可点，hover 只显示摘要。
 *
 * @param {object} props
 * @param {string} props.conceptId 注册表中的稳定 id。
 * @returns {JSX.Element | null}
 */
export function ConceptHelpTrigger({ conceptId }) {
  const t = useT()
  const { openConceptHelp } = useConceptHelp()
  const concept = getConcept(conceptId)
  if (!concept) return null
  const term = t(`help.concept.${conceptId}.term`)
  const summary = t(`help.concept.${conceptId}.summary`)
  const label = t('help.center.learnAbout', { term: term.startsWith('help.concept.') ? conceptId : term })
  return (
    <button
      type="button"
      className="concept-help-trigger is-compact"
      aria-label={label}
      title={summary.startsWith('help.concept.') ? label : summary}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openConceptHelp(conceptId)
      }}
    >
      ?
    </button>
  )
}
