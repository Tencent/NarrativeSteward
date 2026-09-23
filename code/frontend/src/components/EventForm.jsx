import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useDraft } from '../hooks/useDraft'
import { useT } from '../i18n'
import { scalarContractErrors } from '../scalarContract'
import {
  formatStateVariableValue,
  stateVariableValueOptions,
} from '../stateVariableValues'
import EventGraphView from './EventGraphView'
import { ConceptHelpTrigger } from './ConceptHelpContext'
import FragmentShell from './FragmentShell'
import TextFieldRow from './fields/TextFieldRow'
import SelectFieldRow from './fields/SelectFieldRow'

// 事件阶段编辑器（events.json）：关系图与状态变量页共享同一份草稿和保存边界。
// 与后端 EventGraph 模型对齐（见 DESIGN §4.2、§5.7），底层 schema 与保存接口不因界面重组而改变。
//
// 设计要点：
// - draft 保存完整 events 内容；未在界面暴露的字段（节点/变量的 id、边的 condition 在
//   未编辑时）通过对象展开原样保留，保证与 Agent 产出的数据无损往返。
// - 状态变量的 min/max/initial 随类型不同而含义不同，故按 type 动态渲染对应控件。

const DEFAULT = { state_variables: [], nodes: [], edges: [] }

/** 状态变量类型下拉。 */
function varTypeOptions(t) {
  return [
    { value: 'flag', label: t('events.types.flag') },
    { value: 'enum', label: t('events.types.enum') },
    { value: 'scalar', label: t('events.types.scalar') },
  ]
}

/** 事件类型下拉。 */
function nodeTypeOptions(t) {
  return [
    { value: 'mainline', label: t('events.types.mainline') },
    { value: 'optional', label: t('events.types.optional') },
    { value: 'ending', label: t('events.types.ending') },
  ]
}
// 不同类型变量可用的比较运算符。
const OPS_DISCRETE = ['==', '!=']
const OPS_SCALAR = ['==', '!=', '>', '>=', '<', '<=']

// 数值文本 → number|null（空串视为未设置；非法数值原样保留，交由后端校验报错）。
const toNum = (s) => {
  if (s === '' || s === null || s === undefined) return null
  const n = Number(s)
  return Number.isNaN(n) ? s : n
}
// 把可能是数值/布尔/空的值转成输入框可显示的字符串。
const asStr = (v) => (v === null || v === undefined ? '' : String(v))

/** 返回 enum 取值编辑阶段可直接发现的错误，避免等后端保存后才报错。 */
function enumValueErrors(variables, t) {
  return variables.flatMap((variable) => {
    if (variable.type !== 'enum') return []
    const allowed = variable.allowed || []
    const prefix = variable.name || variable.id || t('events.variables.unnamedEnum')
    const errors = []
    if (allowed.length === 0) errors.push(t('events.variables.needAllowed', { prefix }))
    if (allowed.some((value) => !String(value).trim())) {
      errors.push(t('events.variables.emptyAllowed', { prefix }))
    }
    if (new Set(allowed).size !== allowed.length) {
      errors.push(t('events.variables.duplicateAllowed', { prefix }))
    }
    return errors
  })
}

/** 生成不依赖用户文案的稳定草稿 id。 */
const newId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) || Date.now().toString(36)}`
const newVar = () => ({
  id: newId('var'),
  name: '',
  type: 'flag',
  allowed: [],
  min: null,
  max: null,
  initial: null,
  description: '',
  value_descriptions: {},
})
const newNode = () => ({ id: newId('event'), title: '', summary: '', type: 'mainline', characters: [], locations: [] })
const newEdge = (source = '') => ({ id: newId('edge'), source, target: '', condition: null, label: '' })
const edgeTag = (edge) => edge.id || `${edge.source}->${edge.target}`

export default function EventForm({
  fragment,
  projectId,
  world,
  refreshKey,
  reachability,
  disabled,
  busy = false,
  /** Agent 回合进行中或终态内容尚未装入时为 true；用于保留最后一次有效事件图。 */
  agentTurnActive = false,
  settling = false,
  onSave,
  onDirtyChange,
  onOpenScenes,
  focusNodeId,
  focusEdgeId,
  focusVariableId,
  focusSeq,
  view = 'network',
  onOpenVariables,
  onLocateVariableUsage,
  // 网络视图报 event-node/event-edge，变量页报 variable；隐藏视图清空。
  onInspectorChange,
}) {
  const t = useT()
  const value = { ...DEFAULT, ...(fragment?.content || {}) }
  const [draft, setDraft, dirty, reset] = useDraft(value, fragment?.revision)
  const [saving, setSaving] = useState(false)
  const [selection, setSelection] = useState(null)
  const [variableUsages, setVariableUsages] = useState({})
  const [variableUsagesLoading, setVariableUsagesLoading] = useState(false)
  const [variableUsagesError, setVariableUsagesError] = useState('')

  // 变量读写跨越 events 与全部 scene，统一从只读索引接口加载。
  useEffect(() => {
    if (!projectId) {
      setVariableUsages({})
      return undefined
    }
    let alive = true
    setVariableUsagesLoading(true)
    setVariableUsagesError('')
    api.getStateVariableUsages(projectId)
      .then(({ variables }) => {
        if (!alive) return
        setVariableUsages(Object.fromEntries(
          (variables || []).map((item) => [item.variable_id, item]),
        ))
      })
      .catch((error) => {
        if (!alive) return
        setVariableUsages({})
        setVariableUsagesError(error.message || t('events.variables.usageFailed'))
      })
      .finally(() => {
        if (alive) setVariableUsagesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId, refreshKey, fragment?.revision, t])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // 正式检测定位可重复打开同一对象；focusSeq 递增确保每次请求都更新检查器。
  useEffect(() => {
    if (!focusSeq) return undefined
    if (!focusNodeId && !focusEdgeId) {
      setSelection(null)
      return undefined
    }
    setSelection(focusEdgeId
      ? { kind: 'edge', id: focusEdgeId }
      : { kind: 'node', id: focusNodeId })
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq])

  const vars = draft.state_variables || []
  const nodes = draft.nodes || []
  const edges = draft.edges || []
  const scalarErrors = useMemo(
    () => scalarContractErrors({ stateVariables: vars, eventEdges: edges }, t),
    [vars, edges, t],
  )
  const valueErrors = useMemo(() => enumValueErrors(vars, t), [vars, t])
  const contractErrors = [...scalarErrors, ...valueErrors]
  const [showContractErrors, setShowContractErrors] = useState(false)

  // 供边的 source/target 选择、condition 的变量选择用的下拉选项。
  const nodeOptions = useMemo(
    () => [{ value: '', label: t('events.inspector.chooseEvent') }, ...nodes.map((n) => ({ value: n.id, label: n.title || n.id }))],
    [nodes, t],
  )
  const varById = useMemo(() => Object.fromEntries(vars.map((v) => [v.id, v])), [vars])
  const nodeById = useMemo(() => Object.fromEntries(nodes.map((node) => [node.id, node])), [nodes])
  const persistedNodeIds = useMemo(
    () => new Set((fragment?.content?.nodes || []).map((node) => node.id)),
    [fragment?.content?.nodes],
  )

  // ── 列表更新辅助 ───────────────────────────────────────────
  const setVars = (v) => setDraft({ ...draft, state_variables: v })
  const setNodes = (v) => setDraft({ ...draft, nodes: v })
  const setEdges = (v) => setDraft({ ...draft, edges: v })
  const updateVar = (i, patch) => setVars(vars.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const updateNode = (i, patch) => setNodes(nodes.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const updateEdge = (i, patch) => setEdges(edges.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const removeNode = (index) => {
    const removedId = nodes[index]?.id
    const removedEdgeIds = new Set(
      edges.filter((edge) => edge.source === removedId || edge.target === removedId).map((edge) => edge.id),
    )
    setDraft({
      ...draft,
      nodes: nodes.filter((_, i) => i !== index),
      edges: edges.filter((edge) => !removedEdgeIds.has(edge.id)),
    })
  }
  const removeEdge = (index) => setEdges(edges.filter((_, i) => i !== index))

  // 切换变量类型时，重置与新类型无关的字段，避免残留导致后端 extra/类型校验失败。
  const changeVarType = (i, type) => {
    updateVar(i, {
      type,
      allowed: [],
      min: null,
      max: null,
      initial: null,
      value_descriptions: {},
    })
  }

  const save = async () => {
    if (contractErrors.length > 0) {
      setShowContractErrors(true)
      return
    }
    setShowContractErrors(false)
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  /** 新增事件并立即在检查器中打开。 */
  const addNode = () => {
    if (disabled) return
    const node = newNode()
    setNodes([...nodes, node])
    setSelection({ kind: 'node', id: node.id })
  }

  /** 从当前事件新增玩家选择，起点自动固定为当前事件。 */
  const addOutgoingEdge = (sourceId) => {
    if (disabled) return
    const edge = newEdge(sourceId)
    setEdges([...edges, edge])
    setSelection({ kind: 'edge', id: edge.id })
  }

  const selectedNodeIndex = selection?.kind === 'node'
    ? nodes.findIndex((node) => node.id === selection.id)
    : -1
  const selectedEdgeIndex = selection?.kind === 'edge'
    ? edges.findIndex((edge) => edgeTag(edge) === selection.id)
    : -1
  const selectedNode = selectedNodeIndex >= 0 ? nodes[selectedNodeIndex] : null
  const selectedEdge = selectedEdgeIndex >= 0 ? edges[selectedEdgeIndex] : null

  // 隐藏的网络或变量页不得继续贡献旧检查器；切到事件列表/检测时清空。
  useEffect(() => {
    if (view !== 'network') {
      if (view !== 'variables') onInspectorChange?.(null)
      return undefined
    }
    if (selection?.kind === 'node' && selectedNode) {
      onInspectorChange?.({ kind: 'event-node', id: selectedNode.id })
      return undefined
    }
    if (selection?.kind === 'edge' && selectedEdge) {
      onInspectorChange?.({ kind: 'event-edge', id: selectedEdge.id || edgeTag(selectedEdge) })
      return undefined
    }
    onInspectorChange?.(null)
    return undefined
  }, [view, selection, selectedNode, selectedEdge, onInspectorChange])

  // Agent 流式文本会让 App 频繁重渲染。画布回调必须保持引用稳定，否则 React Flow 会在
  // “只回答、不改内容”的回合中反复重建全部节点和边，最终可能留下空视口。
  const selectGraphNode = useCallback((id) => {
    setSelection({ kind: 'node', id })
  }, [])
  const selectGraphEdge = useCallback((id) => {
    setSelection({ kind: 'edge', id })
  }, [])

  return (
    <FragmentShell
      title={view === 'variables' ? t('events.variables.title') : t('workspace.eventsSubtabs.network')}
      conceptId={view === 'variables' ? 'stateVariable' : 'eventNetwork'}
      hint={view === 'variables' ? t('events.variables.hint') : t('events.variables.networkHint')}
      revision={fragment?.revision}
      stage={fragment?.stage}
      dirty={dirty}
      disabled={disabled}
      saving={saving}
      stickyActions
      compactHeader
      onSave={save}
      onReset={() => {
        reset()
        setSelection(null)
      }}
    >
      {showContractErrors && contractErrors.length > 0 && (
        <div className="banner">
          {t('events.variables.cannotSave', { detail: contractErrors.join(t('events.variables.errorSep')) })}
        </div>
      )}
      <div
        className="state-variables-page"
        data-quickstart="panel-variables"
        hidden={view !== 'variables'}
      >
          <StateVariablesInspector
            vars={vars}
            edges={edges}
            usages={variableUsages}
            usagesLoading={variableUsagesLoading}
            usagesError={variableUsagesError}
            disabled={disabled}
            active={view === 'variables'}
            focusVariableId={focusVariableId}
            focusSeq={focusSeq}
            onInspectorChange={onInspectorChange}
            onAdd={() => {
              if (disabled) return vars[0]?.id || ''
              const variable = newVar()
              setVars([...vars, variable])
              return variable.id
            }}
            onUpdate={updateVar}
            onRemove={(index) => {
              const variable = vars[index]
              const usage = variableUsages[variable?.id]
              const references = (usage?.writes?.length || 0) + (usage?.reads?.length || 0)
              const message = references > 0
                ? t('events.variables.deleteUsed', { name: variable?.name || variable?.id, count: references })
                : t('events.variables.deleteConfirm', { name: variable?.name || variable?.id })
              if (!window.confirm(message)) return false
              setVars(vars.filter((_, itemIndex) => itemIndex !== index))
              return true
            }}
            onChangeType={changeVarType}
            onLocateUsage={onLocateVariableUsage}
          />
      </div>
      <div hidden={view === 'variables'}>
          <div className="event-editor-actions">
        <span className="muted">{t('events.network.clickToEdit')}</span>
        <div>
          <button
            type="button"
            className="btn btn-small"
            data-quickstart="event-add-node"
            onClick={addNode}
            disabled={disabled}
          >
            {t('events.network.addEvent')}
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={onOpenVariables}
          >
            {t('events.variables.count', { count: vars.length })}
          </button>
        </div>
          </div>

          <div className={`event-editor-layout${selection ? ' inspector-open' : ''}`}>
        <div className="event-editor-canvas" data-quickstart="event-network">
          <EventGraphView
            fragment={{ ...fragment, content: draft }}
            projectId={projectId}
            refreshKey={refreshKey}
            reachability={reachability}
            busy={busy}
            agentTurnActive={agentTurnActive}
            settling={settling}
            editorMode
            selectedNodeId={selectedNode?.id || null}
            selectedEdgeId={selectedEdge ? edgeTag(selectedEdge) : null}
            onSelectNode={selectGraphNode}
            onSelectEdge={selectGraphEdge}
            onOpenStateVariables={onOpenVariables}
          />
        </div>
        {selection && (
          <aside className="event-inspector" data-quickstart="event-inspector">
            <div className="event-inspector-head">
              <div>
                <span className="task-kicker">
                  {selection.kind === 'node' ? t('events.inspector.events') : t('events.inspector.choices')}
                </span>
                <h3>
                  {selectedNode?.title || selectedNode?.id
                    || (selectedEdge
                      ? `${nodeById[selectedEdge.source]?.title || selectedEdge.source} → ${nodeById[selectedEdge.target]?.title || selectedEdge.target || t('events.inspector.noTarget')}`
                      : t('events.inspector.notFound'))}
                </h3>
              </div>
              <button type="button" className="btn btn-small btn-ghost" aria-label={t('events.inspector.close')} onClick={() => setSelection(null)}>
                ×
              </button>
            </div>

            {selectedNode && (
              <NodeInspector
                node={selectedNode}
                edges={edges}
                world={world}
                disabled={disabled}
                nodeById={nodeById}
                nodeOptions={nodeOptions}
                vars={vars}
                varById={varById}
                onUpdate={(patch) => updateNode(selectedNodeIndex, patch)}
                onUpdateEdge={updateEdge}
                onRemoveEdge={removeEdge}
                onAddEdge={() => addOutgoingEdge(selectedNode.id)}
                onSelectNode={(id) => setSelection({ kind: 'node', id })}
                onSelectEdge={(id) => setSelection({ kind: 'edge', id })}
                canOpenScenes={!dirty && persistedNodeIds.has(selectedNode.id)}
                onOpenScenes={() => onOpenScenes?.(selectedNode.id)}
                onRemove={() => {
                  const related = edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).length
                  if (window.confirm(t('events.inspector.deleteEvent', { title: selectedNode.title || selectedNode.id, count: related }))) {
                    removeNode(selectedNodeIndex)
                    setSelection(null)
                  }
                }}
              />
            )}
            {selectedEdge && (
              <EdgeItem
                edge={selectedEdge}
                index={selectedEdgeIndex}
                nodeOptions={nodeOptions}
                nodeById={nodeById}
                vars={vars}
                varById={varById}
                disabled={disabled}
                onChange={(patch) => updateEdge(selectedEdgeIndex, patch)}
                onRemove={() => {
                  removeEdge(selectedEdgeIndex)
                  setSelection(null)
                }}
              />
            )}
            {!selectedNode && !selectedEdge && (
              <div className="objlist-empty">{t('events.inspector.gone')}</div>
            )}
          </aside>
        )}
          </div>
      </div>
    </FragmentShell>
  )
}

/**
 * 事件检查器：基本字段、从此出发的选择，以及只读的到达来源。
 */
function NodeInspector({
  node,
  edges,
  world,
  disabled,
  nodeById,
  nodeOptions,
  vars,
  varById,
  onUpdate,
  onUpdateEdge,
  onRemoveEdge,
  onAddEdge,
  onSelectNode,
  onSelectEdge,
  canOpenScenes,
  onOpenScenes,
  onRemove,
}) {
  const t = useT()
  const outgoing = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.source === node.id)
  const incoming = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.target === node.id)

  return (
    <div className="event-inspector-body">
      <div className="event-inspector-buttons">
        <button
          type="button"
          className="btn btn-small"
          data-quickstart="event-open-scene"
          disabled={!canOpenScenes}
          title={canOpenScenes ? t('events.inspector.openSceneHint') : t('events.inspector.saveFirst')}
          onClick={onOpenScenes}
        >
          {t('events.inspector.openScene')}
        </button>
        {!disabled && <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>{t('events.inspector.removeEvent')}</button>}
      </div>
      <TextFieldRow label={t('events.inspector.title')} value={node.title} disabled={disabled} onChange={(value) => onUpdate({ title: value })} />
      <TextFieldRow label={t('events.inspector.summary')} value={node.summary} multiline rows={3} disabled={disabled} onChange={(value) => onUpdate({ summary: value })} />
      <SelectFieldRow label={t('events.inspector.type')} value={node.type} options={nodeTypeOptions(t)} disabled={disabled} onChange={(value) => onUpdate({ type: value })} />
      <ReferenceChecklist
        label={t('events.inspector.characters')}
        options={world?.characters || []}
        selected={node.characters || []}
        disabled={disabled}
        onChange={(characters) => onUpdate({ characters })}
      />
      <ReferenceChecklist
        label={t('events.inspector.location')}
        options={world?.locations || []}
        selected={node.locations || []}
        disabled={disabled}
        onChange={(locations) => onUpdate({ locations })}
      />
      <div className="event-stable-id">{t('events.inspector.stableId')}<code>{node.id}</code></div>

      <section className="event-inspector-section" data-quickstart="event-inspector-outgoing">
        <div className="event-inspector-section-head">
          <div>
            <h4>{t('events.inspector.outgoing')}</h4>
            <p>{t('events.inspector.outgoingHint')}</p>
          </div>
            <button type="button" className="btn btn-small" onClick={onAddEdge} disabled={disabled} data-quickstart="event-add-edge">
              {t('events.network.addChoice')}
            </button>
        </div>
        {outgoing.map(({ edge, index }) => (
          <EdgeItem
            key={edgeTag(edge)}
            edge={edge}
            index={index}
            nodeOptions={nodeOptions}
            nodeById={nodeById}
            vars={vars}
            varById={varById}
            disabled={disabled}
            lockSource
            onFocus={() => onSelectEdge(edgeTag(edge))}
            onChange={(patch) => onUpdateEdge(index, patch)}
            onRemove={() => onRemoveEdge(index)}
          />
        ))}
        {outgoing.length === 0 && <div className="objlist-empty">{t('events.inspector.noOutgoing')}</div>}
      </section>

      <section className="event-inspector-section" data-quickstart="event-inspector-incoming">
        <div className="event-inspector-section-head">
          <div>
            <h4>{t('events.inspector.incoming')}</h4>
            <p>{t('events.inspector.incomingHint')}</p>
          </div>
        </div>
        <div className="event-incoming-list">
          {incoming.map(({ edge }) => (
            <button type="button" key={edgeTag(edge)} onClick={() => onSelectNode(edge.source)}>
              <strong>{nodeById[edge.source]?.title || edge.source}</strong>
              <span>{edge.label || t('events.inspector.noChoiceLabel')}{t('events.inspector.toCurrent')}</span>
              {edge.condition && <small>{t('events.network.hasUnlock')}</small>}
            </button>
          ))}
          {incoming.length === 0 && <div className="objlist-empty">{t('events.inspector.entryEvent')}</div>}
        </div>
      </section>
    </div>
  )
}

/**
 * 用可读卡片名称选择角色或地点引用；没有卡片时明确提示。
 */
function ReferenceChecklist({ label, options, selected, disabled, onChange }) {
  const t = useT()
  const knownIds = new Set(options.map((item) => item.id))
  const unknown = selected.filter((id) => !knownIds.has(id))
  const toggle = (id) => onChange(
    selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
  )
  return (
    <fieldset className="event-reference-list" disabled={disabled}>
      <legend>{label}</legend>
      {options.map((item) => (
        <label key={item.id}>
          <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
          <span>{item.name || item.id}</span>
        </label>
      ))}
      {options.length === 0 && <span className="muted">{t('events.inspector.noCards')}</span>}
      {unknown.length > 0 && <small>{t('events.inspector.unresolvedRefs', { ids: unknown.join(t('common.listSep')) })}</small>}
    </fieldset>
  )
}

/** 将变量初始状态压缩成卡片可读摘要。 */
function variableValueSummary(variable, t) {
  if (variable.type === 'scalar') {
    return t('events.variables.range', {
      min: asStr(variable.min) || '?',
      max: asStr(variable.max) || '?',
      initial: asStr(variable.initial) || t('common.notSet'),
    })
  }
  if (variable.type === 'enum') {
    const described = (variable.allowed || []).filter(
      (value) => variable.value_descriptions?.[value]?.trim(),
    ).length
    return t('events.variables.initialMeanings', {
      initial: formatStateVariableValue(variable, variable.initial, t) || t('common.notSet'),
      filled: described,
      total: (variable.allowed || []).length,
    })
  }
  const described = ['true', 'false'].filter(
    (value) => variable.value_descriptions?.[value]?.trim(),
  ).length
  const initial = variable.initial === null || variable.initial === undefined
    ? t('common.notSet')
    : formatStateVariableValue(variable, variable.initial, t)
  return t('events.variables.initialMeanings', {
    initial,
    filled: described,
    total: 2,
  })
}

/**
 * 把变量读写索引分组展示，并允许跳转到实际使用对象。
 *
 * @param {object} props 组件参数。
 * @param {object} props.variable 当前变量声明。
 * @param {{writes:Array<object>,reads:Array<object>}} props.usage 当前变量索引。
 * @param {boolean} props.loading 是否正在重新统计。
 * @param {(usage:object) => void} props.onLocate 定位回调。
 */
function VariableUsageIndex({
  variable,
  usage,
  loading,
  onLocate,
}) {
  const t = useT()
  const groups = [
    {
      id: 'writes',
      title: t('events.variables.beatWrites'),
      items: usage.writes || [],
      action: t('common.write'),
    },
    {
      id: 'event-reads',
      title: t('events.variables.eventReads'),
      items: (usage.reads || []).filter((item) => item.layer === 'event'),
      action: t('common.check'),
    },
    {
      id: 'scene-reads',
      title: t('events.variables.sceneReads'),
      items: (usage.reads || []).filter((item) => item.layer === 'scene'),
      action: t('common.check'),
    },
  ]
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  return (
    <section className="state-variable-usage-index">
      <div className="state-variable-usage-head">
        <div>
          <h4>{t('events.variables.usageTitle')}</h4>
          <p>{t('events.variables.usageHint')}</p>
        </div>
        <span>{t('events.variables.usageCounts', { writes: usage.writes?.length || 0, reads: usage.reads?.length || 0 })}</span>
      </div>
      {!loading && total === 0 && (
        <div className="objlist-empty">{t('events.variables.usageEmpty')}</div>
      )}
      {groups.map((group) => (
        group.items.length > 0 && (
          <div className="state-variable-usage-group" key={group.id}>
            <strong>{t('events.variables.usageGroup', { title: group.title, count: group.items.length })}</strong>
            {group.items.map((item, index) => (
              <button
                type="button"
                key={`${item.layer}-${item.event_id}-${item.object_id}-${index}`}
                disabled={!onLocate}
                onClick={() => onLocate?.(item)}
              >
                <span>{item.event_title} · {item.label || item.object_id}</span>
                <small>
                  {group.action} {item.operator || 'set'} {formatStateVariableValue(variable, item.value, t)}
                  {' · '}
                  {item.object_id}
                </small>
              </button>
            ))}
          </div>
        )
      ))}
    </section>
  )
}

/** 返回 enum 已被初始值、条件或情节写入引用的运行值。 */
function referencedEnumValues(variable, edges, usage) {
  const result = new Set()
  if (variable.initial !== null && variable.initial !== undefined) {
    result.add(String(variable.initial))
  }
  edges
    .filter((edge) => edge.condition?.var === variable.id)
    .forEach((edge) => result.add(String(edge.condition.value)))
  ;[...(usage.reads || []), ...(usage.writes || [])].forEach((item) => {
    if (item.value !== null && item.value !== undefined) result.add(String(item.value))
  })
  return result
}

/**
 * 集中编辑 enum 的运行值与含义。
 *
 * 已被引用的运行值禁止改名和删除，避免让已有 condition/effect 静默失效；
 * 对应含义不参与运行逻辑，因此始终可以编辑。
 */
function EnumValueDescriptionsEditor({
  variable,
  referencedValues,
  disabled,
  onChange,
}) {
  const t = useT()
  const allowed = variable.allowed || []
  const descriptions = variable.value_descriptions || {}
  const updateValue = (index, nextValue) => {
    const previous = allowed[index]
    const nextAllowed = allowed.map((value, itemIndex) => (
      itemIndex === index ? nextValue : value
    ))
    const nextDescriptions = { ...descriptions }
    if (previous !== nextValue) {
      nextDescriptions[nextValue] = nextDescriptions[previous] || ''
      delete nextDescriptions[previous]
    }
    onChange({ allowed: nextAllowed, value_descriptions: nextDescriptions })
  }
  const updateDescription = (value, description) => {
    onChange({
      value_descriptions: { ...descriptions, [value]: description },
    })
  }
  const addValue = () => {
    let suffix = allowed.length + 1
    let value = `value_${suffix}`
    while (allowed.includes(value)) {
      suffix += 1
      value = `value_${suffix}`
    }
    onChange({
      allowed: [...allowed, value],
      value_descriptions: { ...descriptions, [value]: '' },
    })
  }
  const removeValue = (value) => {
    const nextDescriptions = { ...descriptions }
    delete nextDescriptions[value]
    onChange({
      allowed: allowed.filter((item) => item !== value),
      value_descriptions: nextDescriptions,
    })
  }

  return (
    <fieldset className="state-value-editor" disabled={disabled}>
      <legend>{t('events.variables.allowedMeanings')}</legend>
      <p>{t('events.variables.allowedHint')}</p>
      {allowed.map((value, index) => {
        const locked = referencedValues.has(value)
        return (
          <div className="state-value-editor-row" key={`${index}-${value}`}>
            <TextFieldRow
              label={t('events.variables.runValue', { n: index + 1 })}
              value={value}
              disabled={disabled || locked}
              onChange={(nextValue) => updateValue(index, nextValue)}
            />
            <TextFieldRow
              label={t('events.variables.meaning')}
              value={descriptions[value] || ''}
              disabled={disabled}
              onChange={(description) => updateDescription(value, description)}
            />
            {!disabled && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={locked}
                title={locked ? t('events.variables.usedValue') : t('events.variables.deleteValue')}
                onClick={() => removeValue(value)}
              >
                {t('common.delete')}
              </button>
            )}
          </div>
        )
      })}
      {!disabled && <button type="button" className="btn btn-small" onClick={addValue}>{t('events.variables.addValue')}</button>}
    </fieldset>
  )
}

/** 编辑 flag 固定 true/false 两个值的叙事含义。 */
function FlagValueDescriptionsEditor({
  variable,
  disabled,
  onChange,
}) {
  const t = useT()
  const descriptions = variable.value_descriptions || {}
  return (
    <fieldset className="state-value-editor">
      <legend>{t('events.variables.flagMeanings')}</legend>
      <p>{t('events.variables.flagHint')}</p>
      {['true', 'false'].map((value) => (
        <div className="state-value-editor-row state-value-editor-row-flag" key={value}>
          <div className="state-value-fixed">
            <span>{t('events.variables.runValueLabel')}</span>
            <code>{value}</code>
          </div>
          <TextFieldRow
            label={t('events.variables.meaning')}
            value={descriptions[value] || ''}
            disabled={disabled}
            onChange={(description) => onChange({
              value_descriptions: { ...descriptions, [value]: description },
            })}
          />
        </div>
      ))}
    </fieldset>
  )
}

/**
 * 全局状态变量编辑页：卡片负责总览，侧边检查器编辑一个变量的完整配置。
 * @param {boolean} [active] 是否处于状态变量页；隐藏时不得继续上报检查器。
 * @param {(focus: {kind: string, id?: string|null}|null) => void} [onInspectorChange]
 */
function StateVariablesInspector({
  vars,
  edges,
  usages,
  usagesLoading,
  usagesError,
  disabled,
  active = true,
  focusVariableId,
  focusSeq,
  onAdd,
  onUpdate,
  onRemove,
  onChangeType,
  onLocateUsage,
  onInspectorChange,
}) {
  const t = useT()
  const [selectedId, setSelectedId] = useState(null)
  const selectedIndex = vars.findIndex((variable) => variable.id === selectedId)
  const selected = selectedIndex >= 0 ? vars[selectedIndex] : null
  useEffect(() => {
    if (!focusSeq) return
    setSelectedId(focusVariableId || null)
  }, [focusSeq, focusVariableId])
  // 仅在状态变量页可见时上报；切走后由 EventForm 按 view 清空，避免隐藏页抢占。
  useEffect(() => {
    if (!active) return undefined
    onInspectorChange?.(selected ? { kind: 'variable', id: selected.id } : null)
    return undefined
  }, [active, selected, onInspectorChange])
  const usageFor = (variableId) => usages?.[variableId] || {
    writes: [],
    reads: [],
  }
  const selectedUsage = selected ? usageFor(selected.id) : { writes: [], reads: [] }
  const selectedReferencedValues = selected?.type === 'enum'
    ? referencedEnumValues(selected, edges, selectedUsage)
    : new Set()

  return (
    <div className={`state-variable-layout${selected ? ' inspector-open' : ''}`}>
      <div className="state-variable-browser">
        <div className="state-variable-intro">
          <span>{t('events.variables.totalCount', { count: vars.length })}</span>
          <span className="muted">{t('events.variables.cardHint')}</span>
        </div>
        <div className="state-variable-grid">
          {vars.map((variable) => (
            <button
              type="button"
              className={`state-variable-card${selectedId === variable.id ? ' selected' : ''}`}
              key={variable.id}
              onClick={() => setSelectedId(variable.id)}
            >
              <span className="state-variable-card-head">
                <strong>{variable.name || t('events.variables.unnamedVar')}</strong>
                <span className={`state-variable-type state-variable-type-${variable.type}`}>{variable.type}</span>
              </span>
              <span className="state-variable-summary">{variableValueSummary(variable, t)}</span>
              <span className="state-variable-card-foot">
                <code>{variable.id}</code>
                <span>
                  {t('events.variables.cardCounts', {
                    writes: usageFor(variable.id).writes.length,
                    reads: usageFor(variable.id).reads.length,
                  })}
                </span>
              </span>
            </button>
          ))}
            <button
              type="button"
              className="state-variable-card state-variable-add"
              data-quickstart="variable-add"
              onClick={() => setSelectedId(onAdd())}
              disabled={disabled}
            >
              <strong>{t('events.variables.add')}</strong>
              <span>{t('events.variables.addHint')}</span>
            </button>
        </div>
        {vars.length === 0 && <div className="objlist-empty">{t('events.variables.empty')}</div>}
      </div>

      {selected && (
        <aside className="event-inspector state-variable-inspector" data-quickstart="variable-inspector">
          <div className="event-inspector-head">
            <div>
              <span className="task-kicker">{t('events.variables.title')}</span>
              <h3>{selected.name || selected.id}</h3>
            </div>
            <button type="button" className="btn btn-small btn-ghost" aria-label={t('events.inspector.close')} onClick={() => setSelectedId(null)}>
              ×
            </button>
          </div>
          {usagesLoading && <div className="muted state-variable-usage-loading">{t('events.variables.usageLoading')}</div>}
          {usagesError && <div className="form-error">{usagesError}</div>}
          <div className="event-inspector-body">
            <VariableUsageIndex
              variable={selected}
              usage={selectedUsage}
              loading={usagesLoading}
              onLocate={onLocateUsage}
            />
            <TextFieldRow label={t('events.variables.name')} value={selected.name} disabled={disabled} onChange={(value) => onUpdate(selectedIndex, { name: value })} />
            <SelectFieldRow label={t('events.inspector.type')} value={selected.type} options={varTypeOptions(t)} disabled={disabled} onChange={(value) => onChangeType(selectedIndex, value)} />
            {selected.type === 'enum' && (
              <>
                <EnumValueDescriptionsEditor
                  variable={selected}
                  referencedValues={selectedReferencedValues}
                  disabled={disabled}
                  onChange={(patch) => onUpdate(selectedIndex, patch)}
                />
                <SelectFieldRow
                  label={t('events.variables.initial')}
                  value={asStr(selected.initial)}
                  options={[
                    { value: '', label: t('events.variables.unset') },
                    ...stateVariableValueOptions(selected, t),
                  ]}
                  disabled={disabled}
                  onChange={(value) => onUpdate(selectedIndex, { initial: value === '' ? null : value })}
                />
              </>
            )}
            {selected.type === 'flag' && (
              <>
                <FlagValueDescriptionsEditor
                  variable={selected}
                  disabled={disabled}
                  onChange={(patch) => onUpdate(selectedIndex, patch)}
                />
                <SelectFieldRow
                  label={t('events.variables.initial')}
                  value={asStr(selected.initial)}
                  options={[
                    { value: '', label: t('events.variables.unset') },
                    ...stateVariableValueOptions(selected, t),
                  ]}
                  disabled={disabled}
                  onChange={(value) => onUpdate(selectedIndex, { initial: value === '' ? null : value === 'true' })}
                />
              </>
            )}
            {selected.type === 'scalar' && (
              <div className="event-inline-3">
                <TextFieldRow label={t('events.variables.min')} value={asStr(selected.min)} disabled={disabled} inputType="number" step={1} required onChange={(value) => onUpdate(selectedIndex, { min: toNum(value) })} />
                <TextFieldRow label={t('events.variables.max')} value={asStr(selected.max)} disabled={disabled} inputType="number" step={1} required onChange={(value) => onUpdate(selectedIndex, { max: toNum(value) })} />
                <TextFieldRow
                  label={t('events.variables.initialInt')}
                  value={asStr(selected.initial)}
                  disabled={disabled}
                  inputType="number"
                  step={1}
                  min={selected.min ?? undefined}
                  max={selected.max ?? undefined}
                  onChange={(value) => onUpdate(selectedIndex, { initial: toNum(value) })}
                />
              </div>
            )}
            <TextFieldRow label={t('events.variables.description')} value={selected.description} multiline rows={3} disabled={disabled} onChange={(value) => onUpdate(selectedIndex, { description: value })} />
            <div className="event-stable-id">{t('events.inspector.stableId')}<code>{selected.id}</code></div>
            {!disabled && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  if (onRemove(selectedIndex)) setSelectedId(null)
                }}
              >
                {t('events.variables.remove')}
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

// 单条边的编辑器：起点/终点（下拉选事件）、选项文案、可选解锁条件。
function EdgeItem({
  edge,
  index,
  nodeOptions,
  nodeById,
  vars,
  varById,
  disabled,
  lockSource = false,
  onFocus,
  onChange,
  onRemove,
}) {
  const t = useT()
  const cond = edge.condition || null
  const condVar = cond ? varById[cond.var] : null
  // 条件运算符 / 取值控件随所选变量类型而变。
  const ops = condVar?.type === 'scalar' ? OPS_SCALAR : OPS_DISCRETE

  const setCondField = (patch) => onChange({ condition: { var: '', op: '==', value: '', ...cond, ...patch } })

  // 切换条件引用的变量时，重置取值/运算符为新类型的合理默认。
  const changeCondVar = (varId) => {
    const v = varById[varId]
    const op = v?.type === 'scalar' ? '>=' : '=='
    const value = v?.type === 'flag' ? true : ''
    onChange({ condition: { var: varId, op, value } })
  }

  // 条件取值控件：依变量类型渲染。
  const renderCondValue = () => {
    if (!condVar) return <TextFieldRow label={t('events.scene.value')} value={asStr(cond?.value)} disabled={disabled} onChange={(val) => setCondField({ value: val })} />
    if (condVar.type === 'flag') {
      return (
        <SelectFieldRow
          label={t('events.scene.value')}
          value={asStr(cond?.value)}
          options={stateVariableValueOptions(condVar, t)}
          disabled={disabled}
          onChange={(val) => setCondField({ value: val === 'true' })}
        />
      )
    }
    if (condVar.type === 'enum') {
      return (
        <SelectFieldRow
          label={t('events.scene.value')}
          value={asStr(cond?.value)}
          options={stateVariableValueOptions(condVar, t)}
          disabled={disabled}
          onChange={(val) => setCondField({ value: val })}
        />
      )
    }
    return (
      <TextFieldRow
        label={t('events.scene.integerField', { label: t('events.scene.value') })}
        value={asStr(cond?.value)}
        disabled={disabled}
        inputType="number"
        step={1}
        required
        min={condVar.min ?? undefined}
        max={condVar.max ?? undefined}
        onChange={(val) => setCondField({ value: toNum(val) })}
      />
    )
  }

  return (
    <div className="event-choice-card">
      <div className="objlist-item-head">
        <span className="objlist-item-title">
          {nodeById?.[edge.source]?.title || edge.source || t('events.scene.choiceN', { n: index + 1 })}
          {' → '}
          {nodeById?.[edge.target]?.title || edge.target || t('events.inspector.noTarget')}
        </span>
        <div className="event-choice-actions">
          {onFocus && <button type="button" className="btn btn-small btn-ghost" onClick={onFocus}>{t('events.inspector.inspectAlone')}</button>}
          {!disabled && <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>{t('common.delete')}</button>}
        </div>
      </div>
      <div className={lockSource ? '' : 'event-inline-2'}>
        {!lockSource && (
          <SelectFieldRow label={t('events.inspector.sourceEvent')} value={edge.source} options={nodeOptions} disabled={disabled} onChange={(val) => onChange({ source: val })} />
        )}
        <SelectFieldRow label={t('events.inspector.targetEvent')} value={edge.target} options={nodeOptions} disabled={disabled} onChange={(val) => onChange({ target: val })} />
      </div>
      <TextFieldRow label={t('events.inspector.playerLabel')} value={edge.label} disabled={disabled} onChange={(val) => onChange({ label: val })} />

      <label className="event-cond-toggle">
        <input
          type="checkbox"
          checked={!!cond}
          disabled={disabled}
          onChange={(ev) => onChange({ condition: ev.target.checked ? { var: vars[0]?.id || '', op: '==', value: vars[0]?.type === 'flag' ? true : '' } : null })}
        />
        <span>{t('events.inspector.unlockToggle')}</span>
        <ConceptHelpTrigger conceptId="unlockCondition" />
      </label>
      {cond && (
        <div className="event-inline-3">
          <SelectFieldRow
            label={t('events.inspector.variable')}
            value={cond.var}
            options={[{ value: '', label: t('events.inspector.chooseVariable') }, ...vars.map((v) => ({ value: v.id, label: v.name || v.id }))]}
            disabled={disabled}
            onChange={changeCondVar}
          />
          <SelectFieldRow label={t('events.inspector.operator')} value={cond.op} options={ops.map((o) => ({ value: o, label: o }))} disabled={disabled} onChange={(val) => setCondField({ op: val })} />
          {renderCondValue()}
        </div>
      )}
      <div className="event-stable-id">{t('events.inspector.stableId')}<code>{edge.id}</code></div>
    </div>
  )
}
