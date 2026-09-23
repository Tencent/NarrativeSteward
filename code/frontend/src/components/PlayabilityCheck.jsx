import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { tZh } from '../i18n/translate.js'
import { formatStateVariableValue } from '../stateVariableValues'
import { groupValidationIssues } from '../validationIssues'
import { ConceptHelpTrigger } from './ConceptHelpContext'

/**
 * 主动触发的完整联合状态检测面板。
 *
 * 启动接口立即返回，组件轮询独立运行状态；检测期间通过 `onCheckingChange` 让整个项目界面只读。
 * 任意后续保存都会改变服务端内容指纹，因此旧“通过”结果不会继续展示。
 *
 * @param {{
 *   projectId: string,
 *   disabled?: boolean,
 *   disabledReason?: string,
 *   refreshKey?: number,
 *   onCheckingChange?: (checking: boolean) => void,
 *   onLocate?: (item: Record<string, unknown>) => void,
 *   showRunButton?: boolean,
 * }} props
 */
export default function PlayabilityCheck({
  projectId,
  disabled,
  disabledReason = '',
  refreshKey = 0,
  onCheckingChange,
  onLocate,
  showRunButton = true,
}) {
  const t = useT()
  const [state, setState] = useState({
    status: 'not_checked',
    checked_at: null,
    current_fingerprint: '',
    report: null,
  })
  const [runState, setRunState] = useState({ status: 'idle', progress: {} })
  const [errorMsg, setErrorMsg] = useState('')
  const checking = runState.status === 'running' || runState.status === 'cancelling'

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const next = await api.getValidation(projectId)
      setState(next)
      setErrorMsg('')
    } catch (err) {
      setErrorMsg(err.message || t('validation.errors.statusFailed'))
    }
  }, [projectId, t])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const loadRun = useCallback(async () => {
    if (!projectId) return
    try {
      const next = await api.getValidationRun(projectId)
      setRunState(next)
    } catch (err) {
      setErrorMsg(err.message || t('validation.errors.progressFailed'))
    }
  }, [projectId, t])

  useEffect(() => {
    loadRun()
  }, [loadRun, refreshKey])

  useEffect(() => {
    onCheckingChange?.(checking)
  }, [checking, onCheckingChange])

  useEffect(() => {
    if (!checking) return undefined
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getValidationRun(projectId)
        setRunState(next)
        if (!['running', 'cancelling'].includes(next.status)) {
          await load()
        }
      } catch (err) {
        setErrorMsg(err.message || t('validation.errors.progressFailed'))
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [checking, load, projectId, t])

  const run = async () => {
    setErrorMsg('')
    try {
      setRunState(await api.runValidation(projectId))
    } catch (err) {
      setErrorMsg(err.message || t('validation.errors.runFailed'))
    }
  }

  const cancel = async () => {
    setErrorMsg('')
    try {
      setRunState(await api.cancelValidation(projectId))
    } catch (err) {
      setErrorMsg(err.message || t('validation.errors.cancelFailed'))
    }
  }

  const report = state.report
  const summary = report?.summary
  const issueGroups = useMemo(() => groupValidationIssues(report?.issues, t), [report?.issues, t])
  const warnings = report?.warnings || []
  const status = state.status || 'not_checked'
  const progress = runState.progress || {}
  const complexity = report?.complexity
  const variableNames = useMemo(
    () => Object.fromEntries(
      (complexity?.condition_variables || []).map((variable) => [
        variable.id,
        variable,
      ]),
    ),
    [complexity],
  )
  const progressMemoryRisk = memoryRisk(progress)
  const reportMemoryRisk = memoryRisk(report?.meta)
  const labels = {
    not_checked: t('validation.status.not_checked'),
    incomplete: t('validation.status.incomplete'),
    failed: t('validation.status.failed'),
    passed: t('validation.status.passed'),
  }
  const descriptions = {
    not_checked: t('validation.explain.not_checked'),
    incomplete: t('validation.explain.incomplete'),
    failed: t('validation.explain.failed'),
    passed: t('validation.explain.passed'),
  }
  const statusIcons = {
    not_checked: '●',
    incomplete: '▲',
    failed: '✕',
  }

  return (
    <div className={`pc-panel pc-status-${status}`}>
      <div className="pc-head">
        {showRunButton && (
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={run}
            disabled={disabled || checking}
          >
            {checking ? t('validation.actions.running') : t('validation.actions.run')}
          </button>
        )}
        {checking && (
          <button type="button" className="btn btn-small" onClick={cancel} disabled={runState.status === 'cancelling'}>
            {runState.status === 'cancelling' ? t('validation.actions.cancelling') : t('validation.actions.cancel')}
          </button>
        )}
        <div>
          <div className="pc-status-title" aria-live="polite">
            <ConceptHelpTrigger conceptId="validation" />
            <ConceptHelpTrigger conceptId="validationStatuses" />
            {!checking && statusIcons[status] && (
              <span aria-hidden="true">{statusIcons[status]} </span>
            )}
            {checking ? t('validation.progress.title') : labels[status]}
          </div>
          <div className="muted pc-hint">
            {checking
              ? t('validation.progress.readonly')
              : disabledReason || descriptions[status]}
          </div>
        </div>
      </div>

      {errorMsg && <div className="pc-error">{t('validation.errors.requestFailed', { detail: errorMsg })}</div>}
      {runState.status === 'error' && <div className="pc-error">{runState.error || t('validation.progress.internalError')}</div>}

      {checking && (
        <div className="pc-result">
          <div className="pc-metrics">
            <Metric label={t('validation.progress.processed')} value={(progress.configs_explored || 0).toLocaleString()} />
            <Metric label={t('validation.progress.reached')} value={(progress.positions_reached || 0).toLocaleString()} />
            <Metric label={t('validation.progress.discovered')} value={(progress.configs_discovered || 0).toLocaleString()} />
            <Metric label={t('validation.progress.memory')} value={formatBytes(progress.peak_memory_bytes || 0)} />
          </div>
          <div className="pc-meta muted">
            {t('validation.progress.phaseElapsed', {
              phase: formatPhase(progress.phase, t),
              seconds: Math.round((progress.elapsed_ms || 0) / 1000),
            })}
          </div>
          {progress.phase === 'propagating' && (
            <div className="pc-meta muted">
              {t('validation.progress.liveSummary', {
                count: progress.condition_variable_count || 0,
                live: progress.max_live_variables || 0,
                peak: (progress.peak_states_at_position || 0).toLocaleString(),
              })}
              {progress.peak_position && t('validation.progress.peakAt', { position: formatPosition(progress.peak_position, t) })}
            </div>
          )}
          {progressMemoryRisk && (
            <div className="pc-resource-warning">
              {t('validation.progress.memoryRiskLive', { percent: progressMemoryRisk.percent })}
            </div>
          )}
        </div>
      )}

      {!checking && summary && status !== 'not_checked' && (
        <div className="pc-result">
          <div className="pc-metrics">
            <Metric label={t('validation.progress.events')} value={`${summary.events_reached || 0}/${summary.events_total || 0}`} />
            <Metric label={t('validation.progress.beats')} value={`${summary.beats_reached || 0}/${summary.beats_total || 0}`} />
            <Metric label={t('validation.progress.edges')} value={`${summary.edges_used || 0}/${summary.edges_total || 0}`} />
            <Metric label={t('validation.progress.states')} value={(summary.states_explored || 0).toLocaleString()} />
            <Metric label={t('validation.progress.primary')} value={issueGroups.primary.length} warn={issueGroups.primary.length > 0} />
          </div>

          {issueGroups.primary.length > 0 && (
            <details className="pc-detail pc-detail-warn" open>
              <summary>
                {t('validation.progress.primaryGroups', { count: issueGroups.primary.length })}
                {issueGroups.rawCount > issueGroups.primary.length && t('validation.progress.rawCount', { count: issueGroups.rawCount })}
              </summary>
              <ul className="pc-issue-list">
                {issueGroups.primary.slice(0, 30).map((issue, index) => (
                  <IssueItem
                    issue={issue}
                    key={`${issue.kind}-${issue.edge_id || issue.node_id || issue.event_id || index}`}
                    onLocate={onLocate}
                    variableNames={variableNames}
                  />
                ))}
              </ul>
              {issueGroups.primary.length > 30 && (
                <div className="pc-trunc">{t('validation.progress.morePrimary', { count: issueGroups.primary.length - 30 })}</div>
              )}
            </details>
          )}

          {issueGroups.cascades.length > 0 && (
            <details className="pc-detail pc-detail-cascade">
              <summary>{t('validation.progress.cascades', { count: issueGroups.cascades.length })}</summary>
              <ul className="pc-issue-list">
                {issueGroups.cascades.map((issue, index) => (
                  <li key={`${issue.kind}-${issue.event_id || index}`}>
                    {issue.message}
                    {onLocate && issue.event_id && (
                      <button
                        type="button"
                        className="btn btn-small btn-ghost pc-locate-btn"
                        onClick={() => onLocate(issue)}
                      >
                        {t('validation.progress.locateFirst')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {warnings.length > 0 && (
            <details className="pc-detail">
              <summary>{t('validation.progress.warnings', { count: warnings.length })}</summary>
              <ul className="pc-issue-list">
                {warnings.map((warning, index) => (
                  <li key={`${warning.kind}-${warning.variable_id || index}`}>{warning.message}</li>
                ))}
              </ul>
            </details>
          )}

          {complexity && (
            <ComplexityDetails
              complexity={complexity}
              onLocate={onLocate}
              variableNames={variableNames}
            />
          )}

          {reportMemoryRisk && (
            <div className="pc-resource-warning">
              {t('validation.progress.memoryRiskReport', { percent: reportMemoryRisk.percent })}
            </div>
          )}

          <div className="pc-meta muted">
            {state.checked_at && <>{t('validation.progress.checkedAt', { time: new Date(state.checked_at).toLocaleString() })} · </>}
            {state.current_fingerprint && <>{t('validation.progress.contentId', { id: state.current_fingerprint.slice(0, 10) })} · </>}
            {t('validation.progress.metaLine', {
              ms: report.meta?.elapsed_ms ?? 0,
              memory: formatBytes(report.meta?.peak_memory_bytes || 0),
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 单个检测摘要指标。
 * @param {{label: string, value: string|number, warn?: boolean}} props
 */
function Metric({ label, value, warn = false }) {
  return (
    <div className={`pc-metric ${warn ? 'pc-metric-warn' : ''}`}>
      <div className="pc-metric-value">{value}</div>
      <div className="pc-metric-label">{label}</div>
    </div>
  )
}

/**
 * 渲染一组已去重的主要问题；失败时完整状态放在折叠区，避免长变量列表淹没根因。
 *
 * @param {{
 *   issue: Record<string, any>,
 *   onLocate?: (item: Record<string, unknown>) => void,
 *   variableNames: Record<string, string>
 * }} props 聚合后的问题项与定位回调。
 */
function IssueItem({ issue, onLocate, variableNames }) {
  const t = useT()
  const hasState = issue.state && Object.keys(issue.state).length > 0
  const samples = Array.isArray(issue.samples) ? issue.samples : []
  const reachableValues = Array.isArray(issue.reachable_values) ? issue.reachable_values : []
  const canLocate = Boolean(issue.event_id)
  return (
    <li>
      <div className="pc-issue-message">
        {formatIssueMessage(issue, variableNames, t)}
        {issue.occurrences > 1 && (
          <span className="pc-issue-count">{t('validation.issue.sameRoot', { count: issue.occurrences })}</span>
        )}
        {canLocate && onLocate && (
          <button
            type="button"
            className="btn btn-small btn-ghost pc-locate-btn"
            onClick={() => onLocate(issue)}
          >
            {t('validation.issue.locateEdit')}
          </button>
        )}
      </div>
      {issue.condition && (
        <div className="pc-issue-condition">
          {t('validation.issue.requiredCondition')}{formatVariable(issue.condition.var, variableNames, t)} {issue.condition.op}{' '}
          {formatStateVariableValue(
            variableNames[issue.condition.var],
            issue.condition.value,
          )}
        </div>
      )}
      {reachableValues.length > 0 && (
        <div className="pc-issue-condition">
          {t('validation.issue.reachableActual', {
            values: reachableValues.map(
              (value) => formatStateVariableValue(
                variableNames[issue.condition?.var],
                value,
              ),
            ).join(t('common.listSep')),
          })}
        </div>
      )}
      {hasState && (
        <details className="pc-state-detail">
          <summary>{t('validation.issue.failedState', { count: Object.keys(issue.state).length })}</summary>
          <div className="pc-state-snapshot">
            {formatState(issue.state, variableNames, t)}
          </div>
        </details>
      )}
      {samples.length > 0 && (
        <details className="pc-state-detail">
          <summary>{t('validation.issue.deadSamples', { count: samples.length })}</summary>
          {samples.map((sample, index) => (
            <div className="pc-state-snapshot" key={`sample-${index}`}>
              {sample.state && Object.keys(sample.state).length > 0
                ? formatState(sample.state, variableNames, t)
                : t('validation.progress.noVariables')}
              {Array.isArray(sample.unmet_conditions) && sample.unmet_conditions.length > 0 && (
                <div className="pc-unmet-list">
                  {t('validation.issue.unmet')}
                  {sample.unmet_conditions
                    .map((condition) => formatUnmetCondition(condition, variableNames, t))
                    .join(t('validation.issue.unmetJoin'))}
                </div>
              )}
              {sample.route && <RouteDetails route={sample.route} variableNames={variableNames} />}
            </div>
          ))}
        </details>
      )}
      {issue.route && <RouteDetails route={issue.route} variableNames={variableNames} />}
    </li>
  )
}

/**
 * 展示正式传播的状态规模来源；数值均为事实指标，不划分项目复杂度等级。
 *
 * @param {{
 *   complexity: Record<string, any>,
 *   onLocate?: (item: Record<string, unknown>) => void,
 *   variableNames: Record<string, string>
 * }} props 复杂度数据与定位回调。
 */
function ComplexityDetails({ complexity, onLocate, variableNames }) {
  const t = useT()
  const variables = complexity.condition_variables || []
  const positions = complexity.top_positions || []
  return (
    <details className="pc-detail">
      <summary>{t('validation.progress.stateScale')}</summary>
      <div className="pc-complexity-summary">
        {t('validation.progress.scaleSummary', {
          count: variables.length,
          live: complexity.max_live_variables || 0,
          peak: (complexity.peak_states_at_position || 0).toLocaleString(),
          frontier: (complexity.peak_frontier_states || 0).toLocaleString(),
        })}
      </div>
      {variables.length > 0 && (
        <div className="pc-variable-chips">
          {variables.map((variable) => (
            <span className="pc-variable-chip" key={variable.id}>
              {formatVariable(variable.id, variableNames, t)} · {variable.type} ·
              {' '}{t('validation.progress.valueBits', { size: variable.domain_size, bits: variable.bits })}
            </span>
          ))}
        </div>
      )}
      {positions.length > 0 && (
        <ol className="pc-position-list">
          {positions.slice(0, 10).map((position) => (
            <li key={position.position}>
              <span>
                {t('validation.progress.positionStates', {
                  position: formatPosition(position.position, t),
                  states: position.states.toLocaleString(),
                  live: position.live_before,
                })}
              </span>
              {onLocate && position.event_id && (
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => onLocate(position)}
                >
                  {t('agent.change.locate')}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}

/**
 * 折叠展示检测器自动还原的一条实际路线。
 *
 * @param {{
 *   route: Record<string, any>,
 *   variableNames: Record<string, string>
 * }} props 路线对象与变量名称索引。
 */
function RouteDetails({ route, variableNames }) {
  const t = useT()
  const steps = Array.isArray(route.steps) ? route.steps : []
  return (
    <details className="pc-state-detail">
      <summary>{t('validation.issue.actualRoute', { count: steps.length })}</summary>
      {route.target_state && Object.keys(route.target_state).length > 0 && (
        <div className="pc-route-target">
          {t('validation.issue.reachedState')}
          {formatState(route.target_state, variableNames, t)}
        </div>
      )}
      <ol className="pc-route-list">
        {steps.map((step, index) => (
          <li key={`${step.position}-${index}`}>
            {step.via_edge && <span className="pc-route-edge">{step.via_edge} → </span>}
            {formatPosition(step.position, t)}
          </li>
        ))}
      </ol>
      <div className="muted">{t('validation.issue.routeHint')}</div>
    </details>
  )
}

/**
 * 组合变量文本名称和稳定 id；缺少独立名称时只显示 id。
 * @param {string} variableId 状态变量 id。
 * @param {Record<string, string>} variableNames id 到文本名称的索引。
 * @returns {string} 面向创作者且可精确搜索的变量标签。
 */
function formatVariable(variableId, variableNames, t = tZh) {
  const definition = variableNames[variableId]
  const name = typeof definition === 'string' ? definition : definition?.name
  return name && name !== variableId ? t('validation.issue.varWithId', { name, id: variableId }) : variableId
}

/**
 * 格式化联合状态中的全部变量和值。
 * @param {Record<string, unknown>} state 状态快照。
 * @param {Record<string, string>} variableNames id 到文本名称的索引。
 * @returns {string} 逗号分隔的状态文本。
 */
function formatState(state, variableNames, t = tZh) {
  return Object.entries(state)
    .map(([key, value]) => (
      `${formatVariable(key, variableNames, t)}=${formatStateVariableValue(variableNames[key], value)}`
    ))
    .join(t('common.listSep'))
}

/**
 * 优先用结构化字段生成带变量文本名称的边失败文案。
 * @param {Record<string, any>} issue 正式问题。
 * @param {Record<string, string>} variableNames id 到文本名称的索引。
 * @returns {string} 问题摘要。
 */
function formatIssueMessage(issue, variableNames, t = tZh) {
  // Known diagnostics use structured fields in English; Chinese preserves
  // the original diagnostic message.
  if (issue.kind === 'event_unreachable' && issue.event_id) {
    return t('validation.issue.unreachableEvent', { event: issue.event_id, original: issue.message })
  }
  if (issue.kind === 'beat_unreachable' && issue.event_id && issue.beat_id) {
    return t('validation.issue.unreachableBeat', { event: issue.event_id, beat: issue.beat_id, original: issue.message })
  }
  if (issue.kind === 'dead_end_state' && issue.position) {
    return t('validation.issue.deadEndAt', {
      position: formatPosition(issue.position, t),
      count: issue.occurrences || 1,
      original: issue.message,
    })
  }
  if (
    issue.edge_id
    && issue.condition
    && Array.isArray(issue.reachable_values)
  ) {
    const condition = issue.condition
    const variable = variableNames[condition.var]
    const values = issue.reachable_values
      .map((value) => formatStateVariableValue(variable, value))
      .join(', ')
    return t('validation.issue.edgeRequires', {
      edge: issue.edge_id,
      variable: formatVariable(condition.var, variableNames, t),
      op: condition.op,
      value: formatStateVariableValue(variable, condition.value),
      values,
    })
  }
  return issue.message
}

/**
 * 格式化一条未满足条件。
 * @param {Record<string, unknown>} condition 状态条件。
 * @param {Record<string, string>} variableNames id 到文本名称的索引。
 * @returns {string} 紧凑条件文本。
 */
function formatUnmetCondition(condition, variableNames, t = tZh) {
  return `${formatVariable(condition.var, variableNames, t)} ${condition.op} `
    + formatStateVariableValue(variableNames[condition.var], condition.value)
}

/**
 * 把传播位置标识翻译为编辑器中的事件/beat 位置。
 * @param {string} position 紧凑传播位置。
 * @returns {string} 人读位置。
 */
function formatPosition(position = '', t = tZh) {
  const [kind, eventId, ...rest] = position.split(':')
  if (kind === 'BT') return t('validation.issue.eventBeat', { event: eventId, beats: rest.join(':') })
  if (kind === 'ADV') return t('validation.issue.eventEnd', { event: eventId })
  if (kind === 'EV') return t('validation.issue.eventEnter', { event: eventId })
  return position || t('common.unknownLocation')
}

/**
 * 当实测峰值达到本次内存安全停止线的 80% 时返回运行风险提示。
 * @param {Record<string, any>|null|undefined} metrics 运行进度或报告 meta。
 * @returns {{percent: number}|null} 风险信息；余量充足或无停止线时为 null。
 */
function memoryRisk(metrics) {
  const peak = Number(metrics?.peak_memory_bytes || 0)
  const stop = Number(metrics?.memory_stop_bytes || 0)
  if (!peak || !stop || peak / stop < 0.8) return null
  return { percent: Math.round((peak / stop) * 100) }
}

/**
 * 把字节数格式化为紧凑内存文本。
 * @param {number} value 字节数。
 * @returns {string} MiB 文本。
 */
function formatBytes(value) {
  if (!value) return '—'
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * 把后端阶段标识翻译为面向创作者的文本。
 * @param {string|undefined} phase 阶段标识。
 * @returns {string} 阶段名称。
 */
function formatPhase(phase, t = tZh) {
  const keys = {
    starting: 'validation.progress.prepare',
    preflight: 'validation.progress.basic',
    propagating: 'validation.progress.propagate',
  }
  return t(keys[phase] || 'validation.progress.prepare')
}
