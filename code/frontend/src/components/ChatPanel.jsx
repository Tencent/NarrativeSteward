import { useCallback, useEffect, useRef, useState } from 'react'
import { useAutoGrowTextarea } from '../hooks/useAutoGrowTextarea'
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  nextChatWidthFromKeyboard,
  nextChatWidthFromPointer,
} from '../chatPanelSizing'
import {
  CHANGE_TYPE_LABELS,
  changeDetailLabel,
  changeNavigation,
  formatChangeValue,
  rawChangeValue,
} from '../changePresentation'
import {
  getParentStepId,
  getStepId,
  isStepExpanded,
  shouldRevealStepPayload,
  waitingForModelMessage,
} from '../hooks/useExecutionTrace'
import { ConceptHelpTrigger } from './ConceptHelpContext'
import SafeMarkdown from './SafeMarkdown'
import { tZh } from '../i18n/translate.js'
import { formatPlaytestChipText } from '../playtestContext'
import { useT } from '../i18n'

// 把"步骤已进行的毫秒数"格式化为简短计时（仅 ≥1s 才显示，避免闪烁）。
function fmtElapsed(ms) {
  if (!ms || ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const LEGACY_DONE_LABELS = {
  '正在阅读资料': '已阅读资料',
  '正在撰写内容': '已撰写内容',
  '正在修改内容': '已修改内容',
  '正在查看项目': '已查看项目',
  '正在检索内容': '已检索内容',
  '正在运行完整检测': '已完成完整检测',
  '正在并行生成多张情节': '已生成多张情节',
  '正在梳理步骤': '已梳理步骤',
  '正在撰写故事大纲': '已完成故事大纲',
  '正在构建世界设定': '已完成世界设定',
  '正在设计事件图': '已完成事件图',
  '正在设计场景情节': '已完成场景情节',
}

/**
 * 返回步骤当前状态对应的用户可见文案。
 * @param {object} step 工具步骤。
 * @returns {string} 进行中或已完成文案。
 */
function getStepLabel(step, t = tZh) {
  if (step.outcome === 'rolled_back') return t('agent.tools.rolledBack')
  const tool = step.tool || step.name
  const sub = step.subagent
  if (sub && t(`agent.subagents.${sub}.run`) !== `agent.subagents.${sub}.run`) {
    return step.done ? t(`agent.subagents.${sub}.done`) : t(`agent.subagents.${sub}.run`)
  }
  if (tool && t(`agent.tools.${tool}.run`) !== `agent.tools.${tool}.run`) {
    return step.done ? t(`agent.tools.${tool}.done`) : t(`agent.tools.${tool}.run`)
  }
  if (!step.done) return step.label || t('agent.tools.processing.run')
  return step.doneLabel || step.done_label || LEGACY_DONE_LABELS[step.label] || t('agent.tools.processing.done')
}

/**
 * 把按开始时间记录的扁平步骤整理成稳定的先序层级行。
 * 未找到父节点的旧记录/孤儿节点按顶层展示；visited 同时防御异常循环引用。
 * @param {Array<object>} steps 工具与子 Agent 步骤。
 * @returns {Array<{step: object, depth: number, sourceIndex: number, hasChildren: boolean}>}
 */
function buildStepRows(steps) {
  const indexed = steps.map((step, sourceIndex) => ({ step, sourceIndex }))
  const byId = new Map()
  for (const item of indexed) {
    const id = getStepId(item.step)
    if (id && !byId.has(id)) byId.set(id, item)
  }

  const children = new Map()
  const roots = []
  for (const item of indexed) {
    const parentId = getParentStepId(item.step)
    const ownId = getStepId(item.step)
    if (parentId && parentId !== ownId && byId.has(parentId)) {
      const siblings = children.get(parentId) || []
      siblings.push(item)
      children.set(parentId, siblings)
    } else {
      roots.push(item)
    }
  }

  const rows = []
  const visited = new Set()
  const append = (item, depth) => {
    if (visited.has(item.sourceIndex)) return
    visited.add(item.sourceIndex)
    const id = getStepId(item.step)
    const childItems = (id && children.get(id)) || []
    rows.push({ ...item, depth, hasChildren: childItems.length > 0 })
    for (const child of childItems) append(child, depth + 1)
  }
  for (const root of roots) append(root, 0)
  // 循环或损坏的父引用不会让步骤凭空消失。
  for (const item of indexed) append(item, 0)
  return rows
}

/**
 * 展示单条助手消息的工具过程。进行中步骤及其祖先自动展开；
 * 父任务仍在运行时保持最近子步骤可见；成功后收起，失败保持展开。
 * @param {{steps?: Array<object>, now: number, streaming?: boolean}} props
 */
function Steps({ steps, now, streaming, stopped = false }) {
  const t = useT()
  const [userExpanded, setUserExpanded] = useState({})
  const [panelOpen, setPanelOpen] = useState(Boolean(streaming) || stopped)

  useEffect(() => {
    setPanelOpen(
      Boolean(streaming)
      || Boolean(stopped)
      || Boolean(steps?.some((step) => step.error || step.outcome === 'rolled_back')),
    )
  }, [streaming, stopped, steps])

  if (!steps || steps.length === 0) return null
  const activeCount = steps.filter((step) => !step.done).length
  const rolledCount = steps.filter((step) => step.outcome === 'rolled_back').length
  const summary = stopped
    ? t('agent.chat.stoppedRollback', { count: rolledCount || steps.length })
    : streaming && activeCount > 0
      ? t('agent.chat.runningCount', { count: activeCount })
      : t('agent.chat.finishedCount', { count: steps.length })
  const rows = buildStepRows(steps)
  return (
    <div className="steps-panel">
      <button
        type="button"
        className="steps-toggle"
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen((value) => !value)}
      >
        <span>{summary}</span>
        <span className="steps-toggle-action">
          {streaming ? t('agent.chat.liveProcess') : panelOpen ? t('common.collapse') : t('common.expand')}
          <span className="steps-toggle-arrow" aria-hidden>{panelOpen ? '▴' : '▾'}</span>
        </span>
      </button>
      {panelOpen && (
        <div className="steps">
          {rows.map(({ step: s, depth, sourceIndex, hasChildren }) => {
            const id = getStepId(s)
            const expanded = isStepExpanded(s, steps, userExpanded)
            const elapsed = !s.done && s.startedAt ? fmtElapsed(now - s.startedAt) : ''
            const duration = s.done && s.durationMs ? fmtElapsed(s.durationMs) : ''
            const waitingMessage = waitingForModelMessage(s, steps, t)
            const showDelegationInput = s.input != null && !hasChildren
            return (
              <div
                key={id || sourceIndex}
                className={`step ${s.done ? 'step-done' : 'step-active'} ${s.error ? 'step-error' : ''} ${depth > 0 ? 'step-child' : ''}`}
                style={{ '--step-depth': depth }}
              >
                <button
                  type="button"
                  className="step-summary"
                  onClick={() => {
                    if (!id) return
                    setUserExpanded((prev) => ({ ...prev, [id]: !expanded }))
                  }}
                >
                  <span className={`step-status${s.outcome === 'rolled_back' ? ' is-rolled-back' : s.error ? ' is-error' : ''}`}>
                    {s.outcome === 'rolled_back' ? '↩' : s.error ? '!' : s.done ? '✓' : <span className="spinner" aria-hidden />}
                  </span>
                  <span className="step-label">{getStepLabel(s, t)}</span>
                  {hasChildren && (
                    <span className="step-role">
                      {s.done ? t('agent.chat.rootTask') : waitingMessage ? t('agent.chat.waitingContinue') : t('agent.chat.inProgress')}
                    </span>
                  )}
                  {elapsed && <span className="step-elapsed"> · {elapsed}</span>}
                  {duration && <span className="step-elapsed"> · {duration}</span>}
                </button>
                {shouldRevealStepPayload(s, expanded, steps) && (
                  <div className="step-detail">
                    {waitingMessage && (
                      <div className="step-waiting">{waitingMessage}</div>
                    )}
                    {s.agentText && <pre className="step-agent-text">{s.agentText}</pre>}
                    {showDelegationInput && (
                      <div className="step-payload">
                        <div className="step-payload-label">{t('agent.chat.callArgs')}</div>
                        <pre>{formatPayload(s.input)}</pre>
                      </div>
                    )}
                    {s.output != null && (
                      <div className="step-payload">
                        <div className="step-payload-label">{t('agent.chat.callResult')}</div>
                        <pre>{formatPayload(s.output)}</pre>
                      </div>
                    )}
                    {s.error && <div className="step-error-text">{s.error}</div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatPayload(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const OPERATION_LABELS = {
  add: '新增',
  remove: '删除',
  modify: '修改',
}

/**
 * 展示程序计算的 Agent 单回合修改摘要，并提供保留与整轮撤销。
 * @param {object} props 组件参数。
 * @param {object} props.changeset 持久化 Agent changeset。
 * @param {(changeset: object) => void} props.onKeep 明确保留回调。
 * @param {(changeset: object) => void} props.onRevert 整轮撤销回调。
 * @param {(detail: object, changeset: object) => void} props.onLocate 差异定位回调。
 * @param {(changesetId: string, report: {expanded: boolean, hasLocate: boolean}) => void} [props.onDetailsChange]
 *   细节展开/收起时上报，供定位提示判断当前是否看得见「定位」。
 */
function AgentChangeset({ changeset, onKeep, onRevert, onLocate, changesetExpanded = null, onDetailsChange }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (changesetExpanded === 'expanded') setExpanded(true)
    else if (changesetExpanded === 'collapsed') setExpanded(false)
  }, [changesetExpanded])
  const details = (changeset?.fragments || []).flatMap((fragment) => fragment.details || [])
  const hasLocate = details.some((detail) => changeNavigation(detail, t).enabled)
  useEffect(() => {
    if (!changeset?.id || !changeset.counts?.total) return undefined
    onDetailsChange?.(changeset.id, { expanded, hasLocate })
    return () => onDetailsChange?.(changeset.id, { expanded: false, hasLocate: false })
  }, [changeset?.id, changeset?.counts?.total, expanded, hasLocate, onDetailsChange])
  if (!changeset || !changeset.counts?.total) return null
  const toggle = () => {
    const next = !expanded
    setExpanded(next)
  }
  const run = async (action) => {
    setWorking(true)
    setError('')
    try {
      await action(changeset)
    } catch (err) {
      setError(err.message || t('agent.chat.opFailed'))
    } finally {
      setWorking(false)
    }
  }
  const statusText = changeset.status === 'reverted'
    ? t('agent.chat.undone')
    : changeset.status === 'kept'
      ? changeset.resolution === 'implicit_keep' ? t('agent.chat.continued') : t('agent.chat.kept')
      : t('agent.chat.pending')

  return (
    <div className={`agent-changeset changeset-${changeset.status}`} data-quickstart="agent-changeset">
      <div className="agent-changeset-title-row">
        <ConceptHelpTrigger conceptId="agentChangeset" />
      </div>
      <button
        type="button"
        className="agent-changeset-toggle"
        data-quickstart="agent-changeset-toggle"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span>{t('agent.chat.turnChanges', { count: changeset.counts.total })}</span>
        <span>{statusText} · {expanded ? t('agent.chat.collapseDetails') : t('agent.chat.viewDetails')}</span>
      </button>
      <div className="agent-changeset-counts">
          {Object.entries(CHANGE_TYPE_LABELS)
          .filter(([key]) => changeset.counts[key])
          .map(([key]) => <span key={key}>{t(`agent.change.types.${key}`)} {changeset.counts[key]}</span>)}
      </div>
      {expanded && (
        <div className="agent-changeset-details">
          {details.map((detail, index) => {
            const navigation = changeNavigation(detail, t)
            const hasStructuredValue = (
              (detail.before !== null && typeof detail.before === 'object')
              || (detail.after !== null && typeof detail.after === 'object')
            )
            return (
              <div
                className="agent-change-detail"
                key={`${detail.path}-${index}`}
                data-quickstart={index === 0 ? 'agent-change-detail-first' : undefined}
              >
                <div className="agent-change-detail-head">
                  <strong>
                    {t(`agent.change.${detail.operation}`) !== `agent.change.${detail.operation}`
                      ? t(`agent.change.${detail.operation}`)
                      : (OPERATION_LABELS[detail.operation] || detail.operation)}
                    {' · '}
                    {changeDetailLabel(detail, t)}
                  </strong>
                  <div className="agent-change-detail-tools">
                    {detail.operation === 'remove' && <span>{t('agent.chat.objectRemoved')}</span>}
                    {navigation.enabled && (
                      <button
                        type="button"
                        data-quickstart={index === 0 ? 'agent-locate-first' : undefined}
                        onClick={() => onLocate?.(detail, changeset)}
                      >
                        {navigation.label}
                      </button>
                    )}
                  </div>
                </div>
                <div className="agent-change-path">{detail.path}</div>
                <div className="agent-change-values">
                  <div><span>{t('agent.chat.before')}</span><pre>{formatChangeValue(detail, detail.before, t)}</pre></div>
                  <div><span>{t('agent.chat.after')}</span><pre>{formatChangeValue(detail, detail.after, t)}</pre></div>
                </div>
                {hasStructuredValue && (
                  <details className="agent-change-raw">
                    <summary>{t('agent.chat.viewRaw')}</summary>
                    <div className="agent-change-values">
                      <div><span>{t('agent.chat.before')}</span><pre>{rawChangeValue(detail.before)}</pre></div>
                      <div><span>{t('agent.chat.after')}</span><pre>{rawChangeValue(detail.after)}</pre></div>
                    </div>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
      {changeset.status === 'pending' && (
        <div className="agent-changeset-actions">
          <button type="button" disabled={working} onClick={() => run(onKeep)}>{t('agent.change.keep')}</button>
          <button type="button" className="btn-danger-quiet" disabled={working} onClick={() => run(onRevert)}>
            {t('agent.change.undo')}
          </button>
        </div>
      )}
      {error && <div className="agent-changeset-error">{error}</div>}
    </div>
  )
}

/**
 * 单条对话气泡。助手消息若带修改摘要，会把细节展开状态上报给面板。
 * @param {object} props
 * @param {object} props.msg 消息。
 * @param {number} props.now 步骤计时用的当前时间戳。
 * @param {(changeset: object) => void} [props.onKeepChangeset]
 * @param {(changeset: object) => void} [props.onRevertChangeset]
 * @param {(detail: object, changeset: object) => void} [props.onLocateChange]
 * @param {(changesetId: string, report: {expanded: boolean, hasLocate: boolean}) => void} [props.onChangesetDetailsChange]
 * @param {null | 'collapsed' | 'expanded'} [props.changesetExpanded]
 * @param {(remaining: string[]) => void} [props.onContinue]
 */
function Message({ msg, now, onKeepChangeset, onRevertChangeset, onLocateChange, onChangesetDetailsChange, changesetExpanded, onContinue }) {
  const t = useT()
  if (msg.role === 'system') {
    return <div className="msg-system">{msg.text}</div>
  }
  const isUser = msg.role === 'user'
  const activeStep = !isUser && msg.streaming && !msg.text
    ? (msg.steps || []).filter((s) => !s.done).slice(-1)[0]
    : null
  const remaining = msg.remainingParts || msg.remaining_parts || []
  const partial = Boolean(msg.partial || msg.budgetClosed || msg.budget_closed)
  return (
    <div
      className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}
      data-quickstart={isUser ? 'agent-example' : undefined}
    >
      {!isUser && <Steps steps={msg.steps} now={now} streaming={msg.streaming} stopped={Boolean(msg.stopped)} />}
      {!isUser && (msg.statusNotes || []).map((note, index) => (
        <div key={`${note.at}-${index}`} className={`msg-status-note level-${note.level || 'info'}`}>
          {note.text}
        </div>
      ))}
      <div
        className={`msg-bubble${!isUser && msg.text && !msg.streaming ? ' msg-bubble-markdown' : ''}`}
        data-quickstart={!isUser && msg.changeset?.counts?.total ? 'agent-response' : undefined}
      >
        {msg.text
          ? (!isUser && !msg.streaming
            ? <SafeMarkdown className="chat-markdown">{msg.text}</SafeMarkdown>
            : msg.text)
          : msg.streaming
            ? (
                <span className="msg-thinking">
                  <span className="spinner" aria-hidden />
                  {activeStep ? getStepLabel(activeStep, t) : t('agent.chat.executing')}
                  <span className="ellipsis">…</span>
                </span>
              )
            : ''}
      </div>
      {!isUser && (remaining.length > 0 || partial) && !msg.streaming && !msg.stopped && (
        <div className="partial-continue">
          <div>
            {remaining.length > 0
              ? t('agent.chat.partialNamed', { remaining: remaining.join(t('common.listSep')) })
              : t('agent.chat.partialGeneric')}
          </div>
          {onContinue && (
            <button type="button" onClick={() => onContinue(remaining)}>
              {t('agent.chat.continueRemaining')}
            </button>
          )}
        </div>
      )}
      {!isUser && (
        <AgentChangeset
          changeset={msg.changeset}
          changesetExpanded={changesetExpanded}
          onKeep={onKeepChangeset}
          onRevert={onRevertChangeset}
          onLocate={onLocateChange}
          onDetailsChange={onChangesetDetailsChange}
        />
      )}
    </div>
  )
}

/**
 * 右侧 Agent 对话面板：展示消息流、工具步骤和消息输入，并支持窄栏折叠。
 * 折叠时组件保持挂载，因此消息、滚动容器和未发送文本不会被重置。
 * 输入框随内容增高，上限为 min(320px, 40vh)，超出后内部滚动；折叠时不按窄栏宽度测量。
 * 展开时可从左边缘拖拽或用键盘调整宽度；折叠时仍固定为窄栏。
 * @param {object} props 组件参数。
 * @param {Array<object>} props.messages 当前项目的对话消息。
 * @param {boolean} props.busy Agent 是否正在执行回合。
 * @param {boolean} props.disabled 当前是否缺少可对话项目，或当前项目禁止发送。
 * @param {string} [props.disabledReason] 禁用时的空状态说明。
 * @param {string} [props.busyReason] 忙碌但不是 Agent 回合时的输入说明，例如配图正在生成。
 * @param {boolean} props.collapsed 是否显示为窄栏。
 * @param {number} [props.width] 展开态显示宽度。
 * @param {{min?: number, max?: number}} [props.widthBounds] 当前视口下的可调范围。
 * @param {(width: number) => void} [props.onWidthChange] 用户调整后的偏好宽度。
 * @param {(text: string) => Promise<{accepted?: boolean}|void>} props.onSend 消息发送回调；accepted 后才清空输入。
 * @param {() => void} props.onToggle 展开或收起面板的回调。
 * @param {(changeset: object) => Promise<void>} props.onKeepChangeset 保留 Agent 修改。
 * @param {(changeset: object) => Promise<void>} props.onRevertChangeset 撤销 Agent 修改。
 * @param {(detail: object, changeset: object) => void} props.onLocateChange 定位修改对象。
 * @param {(open: boolean) => void} [props.onChangesetDetailsChange]
 *   任一修改细节展开且带定位按钮时为 true；收起、折叠对话或卸下后为 false。
 * @param {string} [props.turnPhase] Agent 回合相位：idle / running / stop_requested / stopped / completing。
 * @param {() => void} [props.onStopTurn] 用户确认后请求停止并撤销本轮。
 * @param {boolean} [props.stopBusy] 停止请求正在提交。
 * @param {null | 'collapsed' | 'expanded'} [props.changesetExpanded] 上手对修改记录的三态控制：未介入 / 强制收起 / 强制展开。
 * @param {{kind?: string, eventTitle?: string, beatPreview?: string, focusLabel?: string}|null} [props.contextChip]
 *   试玩情景标签；无情景时不渲染。
 */
export default function ChatPanel({
  messages,
  busy,
  disabled,
  disabledReason,
  busyReason,
  collapsed,
  width = CHAT_PANEL_DEFAULT_WIDTH,
  widthBounds,
  onWidthChange,
  changesetExpanded = null,
  onSend,
  onToggle,
  onKeepChangeset,
  onRevertChangeset,
  onLocateChange,
  onChangesetDetailsChange,
  onContinue,
  turnPhase = 'idle',
  onStopTurn,
  stopBusy = false,
  contextChip = null,
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [now, setNow] = useState(Date.now())
  const [confirmStop, setConfirmStop] = useState(false)
  const [resizing, setResizing] = useState(false)
  const scrollRef = useRef(null)
  const dragRef = useRef(null)
  const inputRef = useAutoGrowTextarea({
    value: text,
    enabled: !collapsed,
    maxHeight: 'viewport-cap',
  })
  const detailsByIdRef = useRef({})

  /**
   * 汇总各条摘要是否展开且带定位；对话收起时视为不可见。
   * @param {string} changesetId
   * @param {{expanded: boolean, hasLocate: boolean}} report
   */
  const handleChangesetDetailsChange = useCallback((changesetId, report) => {
    if (!changesetId) return
    detailsByIdRef.current[changesetId] = report
    if (collapsed) {
      onChangesetDetailsChange?.(false)
      return
    }
    const open = Object.values(detailsByIdRef.current).some((item) => item?.expanded && item.hasLocate)
    onChangesetDetailsChange?.(open)
  }, [collapsed, onChangesetDetailsChange])

  useEffect(() => {
    if (collapsed) {
      onChangesetDetailsChange?.(false)
      return undefined
    }
    const open = Object.values(detailsByIdRef.current).some((item) => item?.expanded && item.hasLocate)
    onChangesetDetailsChange?.(open)
    return () => onChangesetDetailsChange?.(false)
  }, [collapsed, onChangesetDetailsChange])

  const agentRunning = turnPhase === 'running' || turnPhase === 'stop_requested' || turnPhase === 'completing'
  const stopping = turnPhase === 'stop_requested'
  const showStop = (turnPhase === 'running' || stopping) && typeof onStopTurn === 'function'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!busy && !agentRunning) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy, agentRunning])

  useEffect(() => {
    if (!resizing) return undefined
    document.body.classList.add('is-chat-resizing')
    return () => document.body.classList.remove('is-chat-resizing')
  }, [resizing])

  const send = async () => {
    const t = text.trim()
    if (!t || busy || disabled || agentRunning) return
    const result = await onSend(t)
    if (result?.accepted) setText('')
  }

  // 先弹出确认；接受后才请求服务端停止并整轮撤销。
  const requestStop = () => {
    if (!showStop || stopping || stopBusy) return
    setConfirmStop(true)
  }

  const confirmAndStop = () => {
    setConfirmStop(false)
    onStopTurn?.()
  }

  const rangeMin = widthBounds?.min ?? CHAT_PANEL_MIN_WIDTH
  const rangeMax = widthBounds?.max ?? CHAT_PANEL_MAX_WIDTH
  const canResize = !collapsed && typeof onWidthChange === 'function'

  const resetWidth = () => {
    if (!canResize) return
    onWidthChange(CHAT_PANEL_DEFAULT_WIDTH)
  }

  const handleResizePointerDown = (event) => {
    if (!canResize || event.button !== 0) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleResizePointerMove = (event) => {
    if (!dragRef.current) return
    onWidthChange(nextChatWidthFromPointer({
      startWidth: dragRef.current.startWidth,
      startX: dragRef.current.startX,
      clientX: event.clientX,
    }))
  }

  const endResize = (event) => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleResizeKeyDown = (event) => {
    if (!canResize) return
    if (event.key === 'Home' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      onWidthChange(nextChatWidthFromKeyboard(width, event.key))
    }
  }

  const stopLabel = stopping || stopBusy ? t('agent.chat.stopping') : t('agent.chat.stopAndUndo')
  const inputPlaceholder = stopping
    ? t('agent.chat.stopping')
    : busyReason
      ? busyReason
      : busy
        ? t('agent.chat.generating')
        : t('agent.chat.inputHint')

  return (
    <div
      className={`chat${collapsed ? ' is-collapsed' : ''}${resizing ? ' is-resizing' : ''}`}
      data-quickstart="agent"
      style={{ '--chat-panel-width': `${width}px` }}
    >
      {canResize && (
        <div
          className="chat-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('agent.chat.resizeHandle')}
          aria-valuemin={rangeMin}
          aria-valuemax={rangeMax}
          aria-valuenow={width}
          title={t('agent.chat.resetWidth')}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetWidth}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      <div className="chat-head">
        <span className="chat-title">
          {t('agent.chat.title')}
          <ConceptHelpTrigger conceptId="agent" />
        </span>
        {showStop && (
          <button
            type="button"
            className="btn btn-stop chat-stop-compact"
            disabled={stopping || stopBusy}
            title={stopLabel}
            aria-label={stopLabel}
            onClick={requestStop}
          >
            {stopping || stopBusy ? t('agent.chat.stoppingShort') : t('agent.chat.stop')}
          </button>
        )}
        <button
          type="button"
          className="panel-toggle"
          aria-label={collapsed ? t('agent.chat.expandPanel') : t('agent.chat.collapsePanel')}
          aria-expanded={!collapsed}
          title={collapsed ? t('agent.chat.expandPanel') : t('agent.chat.collapsePanel')}
          onClick={onToggle}
        >
          <span aria-hidden>{collapsed ? '‹' : '›'}</span>
        </button>
      </div>
      {confirmStop && (
        <div className="chat-stop-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-stop-title">
          <p id="chat-stop-title">
            {t('agent.chat.stopConfirm')}
          </p>
          <div className="chat-stop-actions">
            <button type="button" className="btn" onClick={() => setConfirmStop(false)}>
              {t('agent.chat.continueGenerate')}
            </button>
            <button type="button" className="btn btn-stop" onClick={confirmAndStop}>
              {t('agent.chat.stopAndUndo')}
            </button>
          </div>
        </div>
      )}
      <div className="chat-content" aria-hidden={collapsed}>
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="chat-empty">
              {disabled
                ? (disabledReason || t('agent.chat.placeholderNoProject'))
                : t('agent.chat.placeholder')}
            </div>
          )}
          {messages.map((m, i) => (
            <Message
              key={i}
              msg={m}
              now={now}
              changesetExpanded={m.changeset?.counts?.total ? changesetExpanded : null}
              onKeepChangeset={onKeepChangeset}
              onRevertChangeset={onRevertChangeset}
              onLocateChange={onLocateChange}
              onChangesetDetailsChange={handleChangesetDetailsChange}
              onContinue={onContinue}
            />
          ))}
        </div>
        <div className="chat-input" data-quickstart="agent-input">
          {contextChip && contextChip.kind && contextChip.kind !== 'none' && (
            <p
              className={`chat-context-chip${contextChip.kind === 'stale' ? ' is-stale' : ''}`}
              data-quickstart="playtest-context"
            >
              {formatPlaytestChipText(contextChip, t)}
            </p>
          )}
          <textarea
            ref={inputRef}
            className="field-textarea-auto"
            value={text}
            rows={3}
            disabled={disabled || busy}
            placeholder={inputPlaceholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {showStop ? (
            <button
              className="btn btn-stop"
              onClick={requestStop}
              disabled={stopping || stopBusy}
            >
              {stopLabel}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={disabled || busy || !text.trim()}>
              {busyReason ? t('common.pleaseWait') : busy ? t('agent.chat.generatingShort') : t('agent.chat.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
