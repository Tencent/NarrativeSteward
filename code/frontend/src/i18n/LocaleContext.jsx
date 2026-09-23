import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { DEFAULT_LOCALE, applyDocumentLang, normalizeLocale, resolveLocale, writeStoredLocale } from './locales.js'
import { translate } from './translate.js'
const LocaleContext = createContext({ locale: DEFAULT_LOCALE, setLocale: () => {}, showLocaleSwitch: true, t: (key, vars) => translate(key, vars, DEFAULT_LOCALE) })
export function LocaleProvider({ children }) {
 const [locale, setLocaleState] = useState(() => { const initial = resolveLocale(); applyDocumentLang(initial); return initial })
 const setLocale = useCallback((next) => { const resolved = normalizeLocale(next); writeStoredLocale(resolved); applyDocumentLang(resolved); setLocaleState(resolved) }, [])
 const value = useMemo(() => ({ locale, setLocale, showLocaleSwitch: true, t: (key, vars) => translate(key, vars, locale) }), [locale, setLocale])
 return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}
export function useLocale() { return useContext(LocaleContext) }

export function useT() { return useLocale().t }
