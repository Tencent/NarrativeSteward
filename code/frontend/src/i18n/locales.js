export const LOCALES = ['zh-CN', 'en-US'];
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_STORAGE_KEY = 'gflow.locale';
export function normalizeLocale(value) {
  return value === 'en-US' ? 'en-US' : DEFAULT_LOCALE;
}
export function detectBrowserLocale(language = typeof navigator !== 'undefined' ? navigator.language : '') {
  return String(language || '').toLowerCase().startsWith('en') ? 'en-US' : DEFAULT_LOCALE;
}
export function readStoredLocale() {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored === 'zh-CN' || stored === 'en-US' ? stored : null;
  } catch {
    return null;
  }
}
export function writeStoredLocale(locale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(locale));
  } catch {}
}
export function resolveLocale() {
  return readStoredLocale() || detectBrowserLocale();
}
export function applyDocumentLang(locale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = normalizeLocale(locale);
}
