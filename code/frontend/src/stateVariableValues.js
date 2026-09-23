import { tZh } from './i18n/translate.js'

/**
 * 把运行值转换成 value_descriptions 使用的稳定字符串键。
 *
 * @param {unknown} value 状态变量运行值。
 * @returns {string} 映射键。
 */
export function stateValueKey(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 读取 flag/enum 某个运行值的叙事含义。
 *
 * @param {object|null|undefined} variable 状态变量声明。
 * @param {unknown} value 运行值。
 * @returns {string} 已填写的含义；缺失时为空串。
 */
export function stateValueDescription(variable, value) {
  return variable?.value_descriptions?.[stateValueKey(value)]?.trim?.() || ''
}

/**
 * 生成下拉框和只读状态统一使用的“原始值 — 含义”文本。
 *
 * @param {object|null|undefined} variable 状态变量声明。
 * @param {unknown} value 运行值。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {string} 可读值文本。
 */
export function formatStateVariableValue(variable, value, t = tZh) {
  const raw = stateValueKey(value)
  const description = stateValueDescription(variable, value)
  if (description) return `${raw} — ${description}`
  if (raw && ['flag', 'enum'].includes(variable?.type)) {
    return t('events.variables.missingMeaning', { raw })
  }
  return raw
}

/**
 * 返回 flag/enum 可选值及可读标签。
 *
 * @param {object|null|undefined} variable 状态变量声明。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {Array<{value:string,label:string}>} 下拉框选项。
 */
export function stateVariableValueOptions(variable, t = tZh) {
  if (variable?.type === 'flag') {
    return [true, false].map((value) => ({
      value: stateValueKey(value),
      label: formatStateVariableValue(variable, value, t),
    }))
  }
  if (variable?.type === 'enum') {
    return (variable.allowed || []).map((value) => ({
      value,
      label: formatStateVariableValue(variable, value, t),
    }))
  }
  return []
}
