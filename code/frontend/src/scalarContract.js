import { tZh } from './i18n/translate.js'

/**
 * 全部 scalar 的前端镜像校验。
 *
 * 后端保存校验是最终权威；这里用于在表单提交前给出即时、可定位的反馈。
 */

const isFiniteInteger = (value) => (
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
)

/**
 * 校验当前表单可见范围内的全局 scalar 整数契约。
 *
 * @param {object} input
 * @param {Array<object>} input.stateVariables 全局变量声明
 * @param {Array<object>} [input.eventEdges] 事件边
 * @param {Array<object>} [input.sceneEdges] 当前 scene 边
 * @param {Array<object>} [input.beats] 当前 scene beats
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {Array<string>} 可展示错误
 */
export function scalarContractErrors({
  stateVariables,
  eventEdges = [],
  sceneEdges = [],
  beats = [],
}, t = tZh) {
  const variables = stateVariables || []
  const variableById = Object.fromEntries(
    variables.map((variable) => [variable.id, variable]),
  )
  const scalarIds = new Set(
    variables
      .filter((variable) => variable.type === 'scalar')
      .map((variable) => variable.id),
  )
  const errors = []

  scalarIds.forEach((variableId) => {
    const variable = variableById[variableId]
    if (!isFiniteInteger(variable?.min) || !isFiniteInteger(variable?.max)) {
      errors.push(t('events.scalar.needBounds', { id: variableId }))
    }
    if (variable?.initial != null && !isFiniteInteger(variable.initial)) {
      errors.push(t('events.scalar.needInitial', { id: variableId }))
    }
  })

  ;[
    ...eventEdges.map((edge) => ({ edge, prefix: t('events.scalar.eventEdge') })),
    ...sceneEdges.map((edge) => ({ edge, prefix: t('events.scalar.sceneEdge') })),
  ].forEach(({ edge, prefix }) => {
    const condition = edge?.condition
    if (
      condition
      && scalarIds.has(condition.var)
      && !isFiniteInteger(condition.value)
    ) {
      errors.push(
        t('events.scalar.conditionInt', {
          where: `${prefix} ${edge.id || `${edge.source}->${edge.target}`}`,
        }),
      )
    }
  })

  beats.forEach((beat) => {
    ;(beat.effects || []).forEach((effect) => {
      if (
        scalarIds.has(effect.var)
        && !isFiniteInteger(effect.value)
      ) {
        errors.push(
          t('events.scalar.effectInt', {
            beat: beat.id,
            var: effect.var,
            op: effect.op,
          }),
        )
      }
    })
  })
  return errors
}
