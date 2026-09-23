import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDraft } from '../hooks/useDraft'
import { useT } from '../i18n'
import { scalarContractErrors } from '../scalarContract'
import { stateVariableValueOptions } from '../stateVariableValues'
import { buildWorldCardIndex, resolveSpeakerReference, speakerSelectOptions } from '../worldCardReferences'
import { ConceptHelpTrigger } from './ConceptHelpContext'
import FragmentShell from './FragmentShell'
import SceneGraphView from './SceneGraphView'
import TextFieldRow from './fields/TextFieldRow'
import SelectFieldRow from './fields/SelectFieldRow'

// 单个事件的场景/情节图字段级表单：情节 beat + 边两块。
// 与后端 SceneGraph 模型对齐（见 DESIGN §4.2 场景层）。effects 是唯一写状态处；
// 状态变量不在此声明——从事件层（events.json）传入 `stateVariables` 供 effect/condition 引用。
//
// 设计要点：
// - draft 保存完整场景内容（含 event_id 原样保留），与 Agent 产出无损往返。
// - effect/condition 的取值控件随所引用变量的类型（flag/enum/scalar）动态渲染。
// - 仅选择点检查器列出「从这里出发」并编辑出边；旁白/对话/独白不摊出边列表，用「+ 接到下一节拍」拉边。

/** 情节节拍类型下拉；文案走字典。 */
function beatKindOptions(t) {
  return [
    { value: 'narration', label: t('events.types.narration') },
    { value: 'monologue', label: t('events.types.monologue') },
    { value: 'dialogue', label: t('events.types.dialogue') },
    { value: 'choice', label: t('events.types.choice') },
  ]
}

/** effect 写法：set 通用赋值；add 仅 scalar 增减。 */
function effectOpOptions(t) {
  return [
    { value: 'set', label: t('events.scene.set') },
    { value: 'add', label: t('events.scene.add') },
  ]
}
const OPS_DISCRETE = ['==', '!=']
const OPS_SCALAR = ['==', '!=', '>', '>=', '<', '<=']

const toNum = (s) => {
  if (s === '' || s === null || s === undefined) return null
  const n = Number(s)
  return Number.isNaN(n) ? s : n
}
const asStr = (v) => (v === null || v === undefined ? '' : String(v))

// dialogue/独白需要发言人，其余（旁白/选择点）不需要。
const HAS_SPEAKER = (kind) => kind === 'dialogue' || kind === 'monologue'
// 每个 beat 都需绑定地点（location，硬引用世界设定 locations），供试玩配背景图（见 DESIGN §5.8）。
/** 生成不会依赖用户文案的情节图稳定 id。 */
const newId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) || Date.now().toString(36)}`
const newBeat = () => ({ id: newId('beat'), kind: 'narration', speaker: '', location: '', content: '', effects: [] })
const newEdge = (source = '') => ({ id: newId('scene-edge'), source, target: '', condition: null, label: '' })
const edgeTag = (edge) => edge.id || `${edge.source}->${edge.target}`
const newEffect = (vars) => {
  const v = vars[0]
  return { var: v?.id || '', op: 'set', value: v?.type === 'flag' ? true : '' }
}

export default function SceneForm({
  fragment,
  eventTitle,
  stateVariables,
  eventEdges,
  world = {},
  disabled,
  refreshing = false,
  generating = false,
  overlayText = null,
  pendingRemote = false,
  focusKind,
  focusId,
  focusSeq,
  onSave,
  onBack,
  onDirtyChange,
  // 本地 selection 上报 scene-beat / scene-edge；选择点仍归入情节节点。
  onInspectorChange,
}) {
  const t = useT()
  // 说明：ScenePanel 以 key={event_id} 挂载本组件，切换事件即整块重挂载、草稿重置；
  // 同一事件内保存/被 Agent 改写时，由 useDraft 依 revision 重新播种。
  const value = { event_id: fragment?.event_id, beats: [], edges: [], ...(fragment?.content || {}) }
  const [draft, setDraft, dirty, reset] = useDraft(value, fragment?.revision)
  const [saving, setSaving] = useState(false)
  const [selection, setSelection] = useState(null)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(
    () => () => onDirtyChange?.(false),
    [onDirtyChange],
  )

  // 检测面板跳转后在画布中选中对应 beat/边；同一对象可通过递增 focusSeq 重复定位。
  useEffect(() => {
    if (!focusSeq) return undefined
    if (!focusKind || !focusId) {
      setSelection(null)
      return undefined
    }
    setSelection({ kind: focusKind === 'edge' ? 'edge' : 'beat', id: focusId })
    return undefined
  }, [focusId, focusKind, focusSeq])

  const vars = stateVariables || []
  const locs = world?.locations || []
  const worldCardIndex = useMemo(() => buildWorldCardIndex(world), [world])
  const beats = draft.beats || []
  const edges = draft.edges || []
  const scalarErrors = useMemo(
    () => scalarContractErrors({
      stateVariables: vars,
      eventEdges: eventEdges || [],
      sceneEdges: edges,
      beats,
    }, t),
    [vars, eventEdges, edges, beats, t],
  )
  const [showScalarErrors, setShowScalarErrors] = useState(false)

  const beatOptions = useMemo(
    () => [{ value: '', label: t('events.scene.chooseBeat') }, ...beats.map((b) => ({ value: b.id, label: b.content ? `${b.id}|${b.content.slice(0, 12)}` : b.id }))],
    [beats, t],
  )
  // beat 地点下拉：源自世界设定 locations（硬引用），空选项提示。
  const locationOptions = useMemo(
    () => [{ value: '', label: t('events.scene.chooseLocation') }, ...locs.map((l) => ({ value: l.id, label: l.name || l.id }))],
    [locs, t],
  )
  const beatById = useMemo(
    () => Object.fromEntries(beats.map((beat) => [beat.id, beat])),
    [beats],
  )
  const varById = useMemo(() => Object.fromEntries(vars.map((v) => [v.id, v])), [vars])

  const setBeats = (v) => setDraft({ ...draft, beats: v })
  const setEdges = (v) => setDraft({ ...draft, edges: v })
  const updateBeat = (i, patch) => setBeats(beats.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const updateEdge = (i, patch) => setEdges(edges.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const removeBeat = (index) => {
    const removedId = beats[index]?.id
    const removedEdgeIds = new Set(
      edges.filter((edge) => edge.source === removedId || edge.target === removedId).map((edge) => edge.id),
    )
    setDraft({
      ...draft,
      beats: beats.filter((_, i) => i !== index),
      edges: edges.filter((edge) => !removedEdgeIds.has(edge.id)),
    })
  }
  const removeEdge = (index) => setEdges(edges.filter((_, i) => i !== index))

  const selectedBeatIndex = selection?.kind === 'beat'
    ? beats.findIndex((beat) => beat.id === selection.id)
    : -1
  const selectedEdgeIndex = selection?.kind === 'edge'
    ? edges.findIndex((edge) => edgeTag(edge) === selection.id)
    : -1
  const selectedBeat = selectedBeatIndex >= 0 ? beats[selectedBeatIndex] : null
  const selectedEdge = selectedEdgeIndex >= 0 ? edges[selectedEdgeIndex] : null

  // 选择点仍归入情节节点提示；关闭、删除或对象消失后清空。
  useEffect(() => {
    if (selection?.kind === 'beat' && selectedBeat) {
      onInspectorChange?.({ kind: 'scene-beat', id: selectedBeat.id })
    } else if (selection?.kind === 'edge' && selectedEdge) {
      onInspectorChange?.({ kind: 'scene-edge', id: selectedEdge.id || edgeTag(selectedEdge) })
    } else {
      onInspectorChange?.(null)
    }
    return () => onInspectorChange?.(null)
  }, [selection, selectedBeat, selectedEdge, onInspectorChange])

  // 与事件画布相同，Agent 流式文本不得仅因父组件重渲染而替换全部 React Flow 对象。
  const selectGraphBeat = useCallback((id) => {
    setSelection({ kind: 'beat', id })
  }, [])
  const selectGraphEdge = useCallback((id) => {
    setSelection({ kind: 'edge', id })
  }, [])
  const speakerOptions = useMemo(
    () => speakerSelectOptions(worldCardIndex, selectedBeat?.speaker || '', t),
    [worldCardIndex, selectedBeat?.speaker, t],
  )
  const speakerDisplayName = useCallback(
    (speaker) => {
      if (!speaker) return ''
      return resolveSpeakerReference(speaker, worldCardIndex, t).displayName
    },
    [worldCardIndex, t],
  )

  const save = async () => {
    if (scalarErrors.length > 0) {
      setShowScalarErrors(true)
      return
    }
    setShowScalarErrors(false)
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <FragmentShell
      title={
        <span>
          <button type="button" className="btn btn-small btn-ghost" onClick={onBack} style={{ marginRight: 8 }}>
            {t('events.scene.backToList')}
          </button>
          {t('events.scene.networkTitle', { title: eventTitle || fragment?.event_id })}
        </span>
      }
      conceptId="sceneNetwork"
      hint={t('events.scene.hint')}
      revision={fragment?.revision}
      dirty={dirty}
      disabled={disabled}
      saving={saving}
      stickyActions
      onSave={save}
      onReset={reset}
    >
      {pendingRemote && (
        <div className="banner">{t('events.scene.pendingRemote')}</div>
      )}
      {showScalarErrors && scalarErrors.length > 0 && (
        <div className="banner">
          {t('events.scalar.cannotSave', { detail: scalarErrors.join(t('events.variables.errorSep')) })}
        </div>
      )}
      <div className="event-editor-actions">
        <span className="muted">{t('events.scene.clickToEdit')}</span>
        <button
          type="button"
          className="btn btn-small"
          data-quickstart="scene-add-beat"
          disabled={disabled}
          onClick={() => {
            if (disabled) return
            const beat = newBeat()
            setBeats([...beats, beat])
            setSelection({ kind: 'beat', id: beat.id })
          }}
        >
          {t('events.scene.addBeat')}
        </button>
      </div>

      <div className={`event-editor-layout scene-editor-layout${selection ? ' inspector-open' : ''}`}>
        <div className="event-editor-canvas">
          <SceneGraphView
            content={draft}
            eventId={fragment?.event_id}
            speakerDisplayName={speakerDisplayName}
            selectedBeatId={selectedBeat?.id || null}
            selectedEdgeId={selectedEdge ? edgeTag(selectedEdge) : null}
            refreshing={refreshing}
            generating={generating}
            confirmedEmpty={!generating && !refreshing && !(draft?.beats || []).length && fragment?.has_scene === false}
            overlayText={overlayText}
            onSelectBeat={selectGraphBeat}
            onSelectEdge={selectGraphEdge}
          />
        </div>

        {selection && (
          <aside className="event-inspector" data-quickstart="scene-inspector">
            <div className="event-inspector-head">
              <div>
                <span className="task-kicker">
                  {selectedBeat ? (selectedBeat.kind === 'choice' ? t('events.types.choice') : t('events.scene.beats')) : t('events.scene.choices')}
                  <ConceptHelpTrigger conceptId={selectedBeat?.kind === 'choice' ? 'choice' : 'beat'} />
                </span>
                <h3>
                  {selectedBeat
                    ? selectedBeat.content?.slice(0, 24) || selectedBeat.id
                    : selectedEdge
                      ? `${selectedEdge.source || t('events.scene.noSource')} → ${selectedEdge.target || t('events.scene.noTarget')}`
                      : t('events.scene.notFound')}
                </h3>
              </div>
              <button type="button" className="btn btn-small btn-ghost" aria-label={t('events.scene.close')} onClick={() => setSelection(null)}>
                ×
              </button>
            </div>

            {selectedBeat && (
              <div className="event-inspector-body">
                <div className="event-inspector-buttons">
                  {selectedBeat.kind !== 'choice' && (
                    <button
                      type="button"
                      className="btn btn-small"
                      data-quickstart="scene-add-edge"
                      disabled={disabled}
                      onClick={() => {
                        if (disabled) return
                        const edge = newEdge(selectedBeat.id)
                        setEdges([...edges, edge])
                        setSelection({ kind: 'edge', id: edge.id })
                      }}
                    >
                      {t('events.scene.connectNext') /* + 接到下一节拍 */}
                    </button>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => {
                        const related = edges.filter((edge) => edge.source === selectedBeat.id || edge.target === selectedBeat.id).length
                        if (window.confirm(t('events.scene.deleteBeat', { count: related }))) {
                          removeBeat(selectedBeatIndex)
                          setSelection(null)
                        }
                      }}
                    >
                      {t('events.scene.removeBeat')}
                    </button>
                  )}
                </div>
                <SelectFieldRow
                  label={t('events.scene.type')}
                  value={selectedBeat.kind}
                  options={beatKindOptions(t)}
                  disabled={disabled}
                  onChange={(kind) => updateBeat(selectedBeatIndex, HAS_SPEAKER(kind) ? { kind } : { kind, speaker: '' })}
                />
                <SelectFieldRow
                  label={t('events.scene.locationRequired')}
                  value={selectedBeat.location || ''}
                  options={locationOptions}
                  disabled={disabled}
                  onChange={(location) => updateBeat(selectedBeatIndex, { location })}
                />
                {HAS_SPEAKER(selectedBeat.kind) && (
                  <SelectFieldRow
                    label={t('events.scene.speakerRequired')}
                    value={selectedBeat.speaker || ''}
                    options={speakerOptions}
                    disabled={disabled}
                    onChange={(speaker) => updateBeat(selectedBeatIndex, { speaker })}
                  />
                )}
                <TextFieldRow
                  label={selectedBeat.kind === 'dialogue' ? t('events.scene.dialogueContent') : selectedBeat.kind === 'monologue' ? t('events.scene.monologueContent') : selectedBeat.kind === 'choice' ? t('events.scene.choicePrompt') : t('events.scene.body')}
                  value={selectedBeat.content}
                  multiline
                  rows={5}
                  disabled={disabled}
                  dataQuickstart="scene-content-field"
                  onChange={(content) => updateBeat(selectedBeatIndex, { content })}
                />
                <EffectsEditor
                  effects={selectedBeat.effects || []}
                  vars={vars}
                  varById={varById}
                  disabled={disabled}
                  onChange={(effects) => updateBeat(selectedBeatIndex, { effects })}
                />
                <div className="event-stable-id">{t('events.inspector.stableId')}<code>{selectedBeat.id}</code></div>
                {selectedBeat.kind === 'choice' && (
                  <ChoiceOutgoingSection
                    sourceBeatId={selectedBeat.id}
                    edges={edges}
                    beatById={beatById}
                    beatOptions={beatOptions}
                    vars={vars}
                    varById={varById}
                    disabled={disabled}
                    onAdd={() => {
                      if (disabled) return
                      setEdges([...edges, newEdge(selectedBeat.id)])
                    }}
                    onUpdateEdge={updateEdge}
                    onRemoveEdge={removeEdge}
                    onFocusEdge={(edge) => setSelection({ kind: 'edge', id: edgeTag(edge) })}
                  />
                )}
              </div>
            )}

            {selectedEdge && (
              <div className="event-inspector-body">
                <SceneEdgeItem
                  edge={selectedEdge}
                  index={selectedEdgeIndex}
                  beatById={beatById}
                  beatOptions={beatOptions}
                  vars={vars}
                  varById={varById}
                  disabled={disabled}
                  onChange={(patch) => updateEdge(selectedEdgeIndex, patch)}
                  onRemove={() => {
                    removeEdge(selectedEdgeIndex)
                    setSelection(null)
                  }}
                />
              </div>
            )}

            {!selectedBeat && !selectedEdge && (
              <div className="objlist-empty">{t('events.scene.gone')}</div>
            )}
          </aside>
        )}
      </div>
    </FragmentShell>
  )
}

/**
 * 选择点检查器里的「从这里出发」：与事件检查器相同，列出并编辑该选择点的出边。
 *
 * @param {object} props 组件参数。
 * @param {string} props.sourceBeatId 当前选择点 id。
 * @param {object[]} props.edges 情节边草稿。
 * @param {Record<string, object>} props.beatById 情节节点索引。
 * @param {object[]} props.beatOptions 终点下拉。
 * @param {object[]} props.vars 状态变量。
 * @param {Record<string, object>} props.varById 变量索引。
 * @param {boolean} props.disabled 是否只读。
 * @param {() => void} props.onAdd 新增一条从当前选择点出发的边。
 * @param {(index: number, patch: object) => void} props.onUpdateEdge 更新边。
 * @param {(index: number) => void} props.onRemoveEdge 删除边。
 * @param {(edge: object) => void} props.onFocusEdge 打开该边的独立检查器。
 */
function ChoiceOutgoingSection({
  sourceBeatId,
  edges,
  beatById,
  beatOptions,
  vars,
  varById,
  disabled,
  onAdd,
  onUpdateEdge,
  onRemoveEdge,
  onFocusEdge,
}) {
  const t = useT()
  const outgoing = edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.source === sourceBeatId)
  return (
    <section className="event-inspector-section" data-quickstart="scene-inspector-outgoing">
      <div className="event-inspector-section-head">
        <div>
          <h4>
            {t('events.inspector.outgoing') /* 从这里出发 */}
            <ConceptHelpTrigger conceptId="choice" />
          </h4>
          <p>{t('events.scene.outgoingHint')}</p>
        </div>
        <button
          type="button"
          className="btn btn-small"
          data-quickstart="scene-add-edge"
          onClick={onAdd}
          disabled={disabled}
        >
          {t('events.network.addChoice')}
        </button>
      </div>
      {outgoing.map(({ edge, index }) => (
        <SceneEdgeItem
          key={edgeTag(edge)}
          edge={edge}
          index={index}
          beatById={beatById}
          beatOptions={beatOptions}
          vars={vars}
          varById={varById}
          disabled={disabled}
          lockSource
          onFocus={() => onFocusEdge(edge)}
          onChange={(patch) => onUpdateEdge(index, patch)}
          onRemove={() => onRemoveEdge(index)}
        />
      ))}
      {outgoing.length === 0 && <div className="objlist-empty">{t('events.scene.noOutgoing')}</div>}
    </section>
  )
}

/**
 * 情节正文截断，供出边标题使用。
 * @param {object|null} beat 情节节点。
 */
function beatCaption(beat) {
  if (!beat) return ''
  const text = (beat.content || '').trim()
  return text ? text.slice(0, 16) : beat.id
}

// 依变量类型 + op 渲染"取值"控件（effect 与 condition 共用）。
function ValueControl({
  label,
  varDef,
  op,
  value,
  disabled,
  integerOnly = false,
  onChange,
}) {
  const t = useT()
  const integerLabel = integerOnly ? t('events.scene.integerField', { label }) : label
  // add（仅 scalar）或未选变量 → 纯数值/文本输入。
  if (!varDef || op === 'add') {
    return (
      <TextFieldRow
        label={integerLabel}
        value={asStr(value)}
        disabled={disabled}
        inputType={varDef?.type === 'scalar' || op === 'add' ? 'number' : 'text'}
        step={integerOnly ? 1 : 'any'}
        required={integerOnly}
        min={op === 'set' ? varDef?.min ?? undefined : undefined}
        max={op === 'set' ? varDef?.max ?? undefined : undefined}
        onChange={(val) => onChange(op === 'add' ? toNum(val) : (varDef ? toNum(val) : val))}
      />
    )
  }
  if (varDef.type === 'flag') {
    return (
      <SelectFieldRow
        label={label}
        value={asStr(value)}
        options={stateVariableValueOptions(varDef, t)}
        disabled={disabled}
        onChange={(val) => onChange(val === 'true')}
      />
    )
  }
  if (varDef.type === 'enum') {
    return (
      <SelectFieldRow
        label={label}
        value={asStr(value)}
        options={stateVariableValueOptions(varDef, t)}
        disabled={disabled}
        onChange={(val) => onChange(val)}
      />
    )
  }
  return (
    <TextFieldRow
      label={integerLabel}
      value={asStr(value)}
      disabled={disabled}
      inputType="number"
      step={integerOnly ? 1 : 'any'}
      required={integerOnly}
      min={varDef.min ?? undefined}
      max={varDef.max ?? undefined}
      onChange={(val) => onChange(toNum(val))}
    />
  )
}

// 某个 beat 的 effects 列表编辑器：每条 = 变量 + op + 取值。
function EffectsEditor({
  effects,
  vars,
  varById,
  disabled,
  onChange,
}) {
  const t = useT()
  const update = (i, patch) => onChange(effects.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))

  // 切换 effect 引用的变量：重置 op/value 为该类型合理默认（scalar 默认 add 便于累加，其余 set）。
  const changeVar = (i, varId) => {
    const v = varById[varId]
    const op = 'set'
    const value = v?.type === 'flag' ? true : ''
    update(i, { var: varId, op, value })
  }
  // 切换 op：add 仅 scalar；value 语义变化时给合理默认。
  const changeOp = (i, eff, op) => {
    const v = varById[eff.var]
    let value = eff.value
    if (op === 'add') value = 0
    else value = v?.type === 'flag' ? true : ''
    update(i, { op, value })
  }

  return (
    <div className="effects">
      <div className="effects-head">
        <span className="muted">{t('events.scene.effectsCount', { count: effects.length })}</span>
        <ConceptHelpTrigger conceptId="stateWrite" />
        {!disabled && (
          <button type="button" className="btn btn-small" onClick={() => onChange([...effects, newEffect(vars)])}>
            + effect
          </button>
        )}
      </div>
      {effects.map((eff, i) => {
        const v = varById[eff.var]
        const ops = effectOpOptions(t)
        const opts = v?.type === 'scalar' ? ops : ops.filter((o) => o.value === 'set')
        return (
          <div className="effect-row" key={i}>
            <div className="event-inline-3">
              <SelectFieldRow
                label={t('events.scene.variable')}
                value={eff.var}
                options={[{ value: '', label: t('events.scene.chooseVariable') }, ...vars.map((vv) => ({ value: vv.id, label: vv.name || vv.id }))]}
                disabled={disabled}
                onChange={(val) => changeVar(i, val)}
              />
              <SelectFieldRow label={t('events.scene.writeStyle')} value={eff.op} options={opts} disabled={disabled} onChange={(val) => changeOp(i, eff, val)} />
              <ValueControl
                label={eff.op === 'add' ? t('events.scene.increment') : t('events.scene.value')}
                varDef={v}
                op={eff.op}
                value={eff.value}
                disabled={disabled}
                integerOnly={v?.type === 'scalar'}
                onChange={(val) => update(i, { value: val })}
              />
            </div>
            {!disabled && (
              <button type="button" className="btn btn-small btn-danger" onClick={() => onChange(effects.filter((_, idx) => idx !== i))}>
                {t('events.scene.removeEffect')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// 单条场景边：起点/终点（选 beat）、选项文案、可选解锁条件（复用 ValueControl）。
// 选择点「从这里出发」里 lockSource，与事件出边列表一致。
function SceneEdgeItem({
  edge,
  index,
  beatById = {},
  beatOptions,
  vars,
  varById,
  disabled,
  lockSource = false,
  highlighted,
  itemRef,
  onFocus,
  onChange,
  onRemove,
}) {
  const t = useT()
  const cond = edge.condition || null
  const condVar = cond ? varById[cond.var] : null
  const ops = condVar?.type === 'scalar' ? OPS_SCALAR : OPS_DISCRETE

  const setCondField = (patch) => onChange({ condition: { var: '', op: '==', value: '', ...cond, ...patch } })
  const changeCondVar = (varId) => {
    const v = varById[varId]
    const op = v?.type === 'scalar' ? '>=' : '=='
    const value = v?.type === 'flag' ? true : ''
    onChange({ condition: { var: varId, op, value } })
  }
  const title = `${edge.label || t('events.scene.choiceN', { n: index + 1 })} → ${beatCaption(beatById[edge.target]) || edge.target || t('events.scene.noTargetBeat')}`

  return (
    <div
      className={`event-choice-card${highlighted ? ' objlist-item-flash' : ''}`}
      ref={itemRef}
    >
      <div className="objlist-item-head">
        <span className="objlist-item-title">{title}</span>
        <div className="event-choice-actions">
          {onFocus && (
            <button type="button" className="btn btn-small btn-ghost" onClick={onFocus}>
              {t('events.inspector.inspectAlone')}
            </button>
          )}
          {!disabled && (
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
              {t('common.delete')}
            </button>
          )}
        </div>
      </div>
      <div className={lockSource ? '' : 'event-inline-2'}>
        {!lockSource && (
          <SelectFieldRow label={t('events.scene.sourceBeat')} value={edge.source} options={beatOptions} disabled={disabled} onChange={(val) => onChange({ source: val })} />
        )}
        <SelectFieldRow label={t('events.scene.targetBeat')} value={edge.target} options={beatOptions} disabled={disabled} onChange={(val) => onChange({ target: val })} />
      </div>
      <TextFieldRow label={t('events.scene.playerLabel')} value={edge.label} disabled={disabled} onChange={(val) => onChange({ label: val })} />
      <label className="event-cond-toggle">
        <input
          type="checkbox"
          checked={!!cond}
          disabled={disabled}
          onChange={(ev) => onChange({ condition: ev.target.checked ? { var: vars[0]?.id || '', op: '==', value: vars[0]?.type === 'flag' ? true : '' } : null })}
        />
        <span>{t('events.inspector.unlockToggle')}</span>
      </label>
      {cond && (
        <div className="event-inline-3">
          <SelectFieldRow
            label={t('events.scene.variable')}
            value={cond.var}
            options={[{ value: '', label: t('events.scene.chooseVariable') }, ...vars.map((v) => ({ value: v.id, label: v.name || v.id }))]}
            disabled={disabled}
            onChange={changeCondVar}
          />
          <SelectFieldRow label={t('events.scene.operator')} value={cond.op} options={ops.map((o) => ({ value: o, label: o }))} disabled={disabled} onChange={(val) => setCondField({ op: val })} />
          <ValueControl
            label={t('events.scene.value')}
            varDef={condVar}
            op={cond.op}
            value={cond.value}
            disabled={disabled}
            integerOnly={condVar?.type === 'scalar'}
            onChange={(val) => setCondField({ value: val })}
          />
        </div>
      )}
      <div className="event-stable-id">{t('events.inspector.stableId')}<code>{edge.id}</code></div>
    </div>
  )
}
