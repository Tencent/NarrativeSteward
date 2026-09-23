export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  applyDocumentLang,
  detectBrowserLocale,
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  writeStoredLocale,
} from './locales.js'
export { createTranslator, interpolate, tZh, translate } from './translate.js'
export { LocaleProvider, useLocale, useT } from './LocaleContext.jsx'
export { default as LocaleSwitch } from './LocaleSwitch.jsx'
