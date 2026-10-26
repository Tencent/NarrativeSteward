import { stateValueDescription } from './stateVariableValues.js'
import { tZh } from './i18n/translate.js'

/** Player text uses authored meanings without exposing internal enum/flag keys. */
export function formatPlayStateValue(variable, value, t = tZh) {
  const description = stateValueDescription(variable, value)
  if (description) return description
  if (value === true) return t('playtest.valueYes')
  if (value === false) return t('playtest.valueNo')
  if (value === null || value === undefined) return t('playtest.valueUnset')
  return String(value)
}

/** Explain exactly the runtime predicate, without inferring narrative causes. */
export function describePlayCondition(condition, vars, varById, t = tZh) {
  if (!condition) return ''
  const variable = varById?.[condition.var]
  const name = variable?.name || condition.var
  const keys = { '==': 'equal', '!=': 'notEqual', '>': 'greater', '>=': 'atLeast', '<': 'less', '<=': 'atMost' }
  const op = keys[condition.op] ? t(`playtest.conditionOps.${keys[condition.op]}`) : condition.op
  return t('playtest.conditionDetail', {
    name, op,
    expected: formatPlayStateValue(variable, condition.value, t),
    actual: formatPlayStateValue(variable, vars[condition.var], t),
  })
}
