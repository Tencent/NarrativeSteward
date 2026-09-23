/**
 * 按稳定 key 读取字典，并用 `{name}` 插值。
 *
 * 缺 key 时回退到中文，再回退到 key 本身，避免英文模式出现空白控件。
 */

import { DEFAULT_LOCALE, normalizeLocale } from './locales.js'
import { dictionaries } from './dictionaries/index.js'

/**
 * 沿点号路径取出嵌套文案。
 * @param {Record<string, unknown>} dict
 * @param {string} key
 * @returns {unknown}
 */
function lookup(dict, key) {
  return String(key || '').split('.').reduce((node, part) => (
    node && typeof node === 'object' ? node[part] : undefined
  ), dict)
}

/**
 * 把模板里的 `{name}` 替换成 vars 中的值。
 * @param {string} template
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
export function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (
    vars[name] === undefined || vars[name] === null ? `{${name}}` : String(vars[name])
  ))
}

/**
 * 读取指定语言的文案。
 * @param {string} key 稳定 key，如 `workspace.tabs.events`。
 * @param {Record<string, unknown>} [vars]
 * @param {string} [locale]
 * @returns {string}
 */
export function translate(key, vars = {}, locale = DEFAULT_LOCALE) {
  const resolved = normalizeLocale(locale)
  const primary = lookup(dictionaries[resolved], key)
  const fallback = resolved === DEFAULT_LOCALE ? undefined : lookup(dictionaries[DEFAULT_LOCALE], key)
  const template = typeof primary === 'string' ? primary : typeof fallback === 'string' ? fallback : key
  return interpolate(template, vars)
}

/**
 * 绑定到某一语言的翻译函数，供非 React 模块默认使用中文。
 * @param {string} [locale]
 * @returns {(key: string, vars?: Record<string, unknown>) => string}
 */
export function createTranslator(locale = DEFAULT_LOCALE) {
  const resolved = normalizeLocale(locale)
  return (key, vars) => translate(key, vars, resolved)
}

/** 中文翻译器：既有检查与无 locale 调用的回归基线。 */
export const tZh = createTranslator(DEFAULT_LOCALE)
