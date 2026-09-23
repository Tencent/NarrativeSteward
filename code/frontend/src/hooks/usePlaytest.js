import { useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { findEntryNodeId } from '../graphUtils'
import { useT } from '../i18n'
import { recordTakenEdge } from '../playtestContext'
import { playtestVisuals } from '../playtestVisuals'
import { buildWorldCardIndex, resolveSpeakerReference } from '../worldCardReferences'

// 试玩引擎（阶段 5）：纯前端内存态的图遍历状态机，不落盘、不经后端 store，
// 见 DESIGN §5.6。事件图与场景图共用同一套"出度>1=选择/出度=1=直接流转/
// 出度=0=终止"规则（§4.2(0)）；beat 进入即应用 effects，全部出边均展示，
// condition 决定选项可点击或置灰。
//
// 只读依赖后端两个既有接口：GET /data/events（整张事件图，一次性拉取）与
// GET /scenes/{event_id}（按事件懒加载情节图，未生成时 content=null）。

// ── 状态变量初始值 ─────────────────────────────────────────────
// initial 缺省时按类型给合理默认：flag→false；enum→allowed[0]；scalar→min ?? 0。
function initVars(stateVariables) {
  const vars = {}
  for (const v of stateVariables || []) {
    if (v.initial !== null && v.initial !== undefined) {
      vars[v.id] = v.initial
      continue
    }
    if (v.type === 'flag') vars[v.id] = false
    else if (v.type === 'enum') vars[v.id] = v.allowed?.[0] ?? ''
    else vars[v.id] = v.min ?? 0
  }
  return vars
}

// ── 条件求值：与后端 check_state_condition 语义一致（==/!=/>/>=/</<=） ──────
function evalCondition(cond, vars) {
  if (!cond) return true
  const cur = vars[cond.var]
  switch (cond.op) {
    case '==':
      return cur === cond.value
    case '!=':
      return cur !== cond.value
    case '>':
      return cur > cond.value
    case '>=':
      return cur >= cond.value
    case '<':
      return cur < cond.value
    case '<=':
      return cur <= cond.value
    default:
      return false
  }
}

// 应用 effects：set 赋值、add 累加；scalar 每次写入后限制在声明的 min/max 内（DESIGN §4.2.2）。
function applyEffects(vars, effects, varById) {
  const next = { ...vars }
  for (const eff of effects || []) {
    let value = eff.op === 'add' ? (next[eff.var] || 0) + eff.value : eff.value
    const declaration = varById?.[eff.var]
    if (declaration?.type === 'scalar') {
      if (declaration.min !== null && declaration.min !== undefined) value = Math.max(value, declaration.min)
      if (declaration.max !== null && declaration.max !== undefined) value = Math.min(value, declaration.max)
    }
    next[eff.var] = value
  }
  return next
}

// 从某节点出发，过滤出"条件满足"的出边（供渲染"下一步/选择"用）。
function satisfiedEdges(nodeId, edges, vars) {
  return (edges || []).filter((e) => e.source === nodeId && evalCondition(e.condition, vars))
}
function allOutEdges(nodeId, edges) {
  return (edges || []).filter((e) => e.source === nodeId)
}

// 图片切换前完成加载与解码，避免 CSS background / <img> 在网络请求期间短暂显示纯色底。
const imagePromiseCache = new Map()
function preloadImage(src) {
  if (!src) return Promise.resolve(false)
  if (imagePromiseCache.has(src)) return imagePromiseCache.get(src)
  const promise = new Promise((resolve) => {
    const image = new Image()
    image.onload = async () => {
      try {
        await image.decode?.()
      } catch {
        // onload 已证明图片可用；部分浏览器不支持 decode 或会在缓存命中时拒绝。
      }
      resolve(true)
    }
    image.onerror = () => resolve(false)
    image.src = src
  })
  imagePromiseCache.set(src, promise)
  return promise
}

/**
 * 只接受已经配置且加载成功的卡片图；缺图或失败时返回空串，由界面改用名称占位。
 *
 * @param {string} candidate 卡片配图 URL；空串表示卡片未挂图。
 * @returns {Promise<string>} 可显示的 URL，或空串。
 */
async function resolvePlaytestImage(candidate) {
  if (!candidate) return ''
  return (await preloadImage(candidate)) ? candidate : ''
}

// 找变量当前值与条件要求的差距（供死路诊断展示）。
function describeGap(cond, vars, varById, t) {
  const v = varById[cond?.var]
  const name = v?.name || cond?.var
  const actual = JSON.stringify(vars[cond?.var])
  return t('playtest.condGap', {
    name,
    op: cond.op,
    expected: JSON.stringify(cond.value),
    actual,
  })
}

/**
 * 试玩引擎 hook。
 *
 * @param {string} projectId 当前项目 id。
 * @returns {{
 *   status: 'idle'|'loading'|'blocked'|'playing'|'dead_end'|'ending'|'error',
 *   history: Array<object>,   // 已走过的 beat/事件展示项（滚动阅读用）
 *   vars: Record<string, any>,
 *   choices: Array<object>,   // 当前全部出边（含 disabled 与原因）；单条可用边渲染成“下一步”
 *   deadEndInfo: string|null,
 *   ending: object|null,      // {title, summary} 通关时
 *   blockedEvent: {id,title}|null,
 *   canUndo: boolean,
 *   isAdvancing: boolean,     // 正在加载/解码下一帧，前端据此防止重复点击
 *   current: {event_id: string, beat_id: string, location_id: string, speaker_id: string}|null,
 *   takenEdges: Array<{kind: 'scene'|'event', edge_id: string}>,
 *   start(): void,
 *   choose(edgeId): void,
 *   undo(): void,
 * }}
 */
export function usePlaytest(projectId) {
  const t = useT()
  const [status, setStatus] = useState('idle')
  const [errorMsg, setErrorMsg] = useState(null)
  const [history, setHistory] = useState([])
  const [vars, setVars] = useState({})
  const [choices, setChoices] = useState([])
  const [deadEndInfo, setDeadEndInfo] = useState(null)
  const [ending, setEnding] = useState(null)
  const [blockedEvent, setBlockedEvent] = useState(null)
  const [isAdvancing, setIsAdvancing] = useState(false)
  // 发送给 Agent 的瞬时情景：当前位置与本局实际经过的图边（含自动单边转移）。
  const [current, setCurrent] = useState(null)
  const [takenEdges, setTakenEdges] = useState([])

  // 图数据缓存：事件图一次性拉取；情节图按事件懒加载。ref 避免图数据触发多余渲染。
  const eventGraphRef = useRef(null) // {nodes, edges, state_variables, nodeById, varById}
  const sceneCacheRef = useRef({}) // event_id -> SceneGraph | null(未生成)
  // speaker 是卡片 id 硬引用（见 DESIGN §4.5）：开局建立六类卡片索引，只按 id 映射显示名。
  const worldCardIndexRef = useRef(buildWorldCardIndex(null))
  // 配图映射（DESIGN §5.8）：地点卡片 id→image（背景图）、角色卡片 id→image（立绘）。
  // 均为可选：无配图或加载失败时界面显示名称并提示缺少配图，不套内置默认图。
  const locImageByIdRef = useRef({})
  const charImageByIdRef = useRef({})
  // 地点卡片 id→name：供画面顶部展示"当前地点名称"。
  const locNameByIdRef = useRef({})
  // 回退栈：每步转移前压入快照 {eventId, beatId, vars, historyLen}。
  const undoStackRef = useRef([])

  const canUndo = undoStackRef.current.length > 0

  const loadScene = useCallback(async (eventId) => {
    if (eventId in sceneCacheRef.current) return sceneCacheRef.current[eventId]
    const state = await api.getScene(projectId, eventId)
    const scene = state?.exists ? state.content : null
    sceneCacheRef.current[eventId] = scene
    return scene
  }, [projectId])

  // 渲染并停在某个 beat：应用 effects → 追加历史 → 计算可选出边 / 死路 / 情节终止。
  const enterBeat = useCallback(
    async (eventNode, scene, beatId, curVars) => {
      const beat = scene.beats.find((b) => b.id === beatId)
      const nextVars = applyEffects(curVars, beat.effects, eventGraphRef.current?.varById)
      const resolved = resolveSpeakerReference(beat.speaker, worldCardIndexRef.current)
      const displayBeat = {
        ...beat,
        speakerDisplayName: resolved.displayName,
        isCharacterSpeaker: resolved.isCharacterSpeaker,
      }
      // 配图（DESIGN §5.8）：背景取地点卡片 image；立绘只给角色发言者。
      const locImg = api.assetUrl(projectId, beat.location ? locImageByIdRef.current[beat.location] : '')
      const isSpeech = (beat.kind === 'dialogue' || beat.kind === 'monologue') && beat.speaker
      const portraitId = resolved.isCharacterSpeaker ? (resolved.cardId || beat.speaker) : ''
      const charImg = api.assetUrl(projectId, portraitId ? charImageByIdRef.current[portraitId] : '')
      // 配图解码前先记下稳定位置，避免对话面板在加载期间拿不到 event_id。
      setCurrent({
        event_id: eventNode.id,
        beat_id: beat.id,
        location_id: beat.location || '',
        speaker_id: beat.speaker || '',
      })
      setVars(nextVars)
      const [loadedBg, loadedChar] = await Promise.all([
        resolvePlaytestImage(locImg),
        resolved.isCharacterSpeaker && isSpeech ? resolvePlaytestImage(charImg) : Promise.resolve(''),
      ])
      const locationName = beat.location ? locNameByIdRef.current[beat.location] || beat.location : ''
      const visuals = playtestVisuals({
        locationName,
        bgImage: loadedBg,
        isSpeech,
        speakerName: displayBeat.speakerDisplayName || '',
        isCharacterSpeaker: resolved.isCharacterSpeaker,
        charImage: loadedChar,
      })
      setHistory((h) => [...h, {
        kind: 'beat',
        eventId: eventNode.id,
        eventTitle: eventNode.title,
        beat: displayBeat,
        isCharacterSpeaker: resolved.isCharacterSpeaker,
        locationName,
        ...visuals,
      }])

      const outs = allOutEdges(beatId, scene.edges)
      const ok = satisfiedEdges(beatId, scene.edges, nextVars)
      return { beat, outs, ok, nextVars }
    },
    [projectId],
  )

  const varById = useMemo(() => eventGraphRef.current?.varById || {}, [status])

  // 情节演完（scene 终止 beat）后，在事件图层做同样的过滤/选择/死路判定。
  const advanceEvent = useCallback(async (fromEventId, curVars) => {
    const g = eventGraphRef.current
    const node = g.nodeById[fromEventId]
    if (node.type === 'ending') {
      setEnding({ title: node.title, summary: node.summary })
      setStatus('ending')
      setChoices([])
      return
    }
    const outs = allOutEdges(fromEventId, g.edges)
    const ok = satisfiedEdges(fromEventId, g.edges, curVars)
    const nextChoices = outs.map((e) => {
      const disabled = !evalCondition(e.condition, curVars)
      return {
        id: e.id,
        label: e.label || g.nodeById[e.target]?.title || e.target,
        kind: 'event',
        edge: e,
        disabled,
        disabledReason: disabled ? describeGap(e.condition, curVars, g.varById, t) : null,
      }
    })
    if (outs.length === 0) {
      // 结构上是终止事件但未标 ending：视为通关（如结局遗漏打标，仍给出体验闭环）。
      setEnding({ title: node.title, summary: node.summary })
      setStatus('ending')
      setChoices([])
      return
    }
    if (ok.length === 0) {
      setDeadEndInfo(
        outs
          .filter((e) => e.condition)
          .map((e) => describeGap(e.condition, curVars, g.varById, t))
          .join(t('playtest.gapSep')) || t('playtest.deadEvent'),
      )
      setStatus('dead_end')
      setChoices(nextChoices)
      pendingRef.current = { kind: 'event_transition', fromEventId }
      return
    }
    if (outs.length === 1 && ok.length === 1) {
      setTakenEdges((edges) => recordTakenEdge(edges, 'event', ok[0].id))
      await enterEvent(ok[0].target, curVars, { autoLabel: ok[0].label })
      return
    }
    setStatus('playing')
    setDeadEndInfo(null)
    setChoices(nextChoices)
    // 暂存"待跳转到哪个事件"的上下文供 choose() 使用。
    pendingRef.current = { kind: 'event_transition', fromEventId }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  // 待选择的上下文（供 choose() 消费，避免多套 state 同步问题）。
  const pendingRef = useRef(null)

  // 进入某个事件：懒加载其情节图，未生成则阻断；否则从入口 beat 开始播。
  const enterEvent = useCallback(
    async (eventId, curVars, opts = {}) => {
      const g = eventGraphRef.current
      const node = g.nodeById[eventId]
      setHistory((h) => [...h, { kind: 'event_enter', title: node.title, label: opts.autoLabel }])
      let scene
      try {
        scene = await loadScene(eventId)
      } catch (err) {
        setErrorMsg(t('playtest.loadSceneFailed', { detail: err.message }))
        setStatus('error')
        return
      }
      if (!scene || !scene.beats?.length) {
        setCurrent({ event_id: eventId, beat_id: '', location_id: '', speaker_id: '' })
        setBlockedEvent({ id: eventId, title: node.title })
        setStatus('blocked')
        return
      }
      setBlockedEvent(null)
      const entryBeatId = findEntryNodeId(scene.beats.map((b) => b.id), scene.edges)
      const { outs, ok, nextVars } = await enterBeat(node, scene, entryBeatId, curVars)
      pendingRef.current = { kind: 'scene', eventId, scene, node }
      if (outs.length === 0) {
        // 终止 beat 先完整停留；由玩家再点一次“下一步”后才进入事件层，避免内容一闪而过。
        pendingRef.current = { kind: 'event_boundary', eventId }
        setStatus('playing')
        setDeadEndInfo(null)
        setChoices([{ id: `__event_boundary__:${eventId}`, label: t('playtest.enterNext'), kind: 'event_boundary', disabled: false }])
        return
      }
      if (ok.length === 0) {
        setDeadEndInfo(
          outs
            .filter((e) => e.condition)
            .map((e) => describeGap(e.condition, nextVars, g.varById, t))
            .join(t('playtest.gapSep')) || t('playtest.deadScene'),
        )
        setStatus('dead_end')
        setChoices(
          outs.map((e) => ({
            id: e.id,
            label: e.label || (scene.beats.find((b) => b.id === e.target)?.content || '').slice(0, 16) || e.target,
            kind: 'beat',
            edge: e,
            disabled: true,
            disabledReason: describeGap(e.condition, nextVars, g.varById, t),
          })),
        )
        return
      }
      setStatus('playing')
      setDeadEndInfo(null)
      setChoices(
        outs.map((e) => {
          const disabled = !evalCondition(e.condition, nextVars)
          return {
            id: e.id,
            label: e.label || (scene.beats.find((b) => b.id === e.target)?.content || '').slice(0, 16) || e.target,
            kind: 'beat',
            edge: e,
            disabled,
            disabledReason: disabled ? describeGap(e.condition, nextVars, g.varById, t) : null,
          }
        }),
      )
    },
    [loadScene, enterBeat, advanceEvent, t],
  )

  // 开始试玩：清空内存中的路线、变量和情节缓存，再拉取最新事件图。
  // 内容版本变化后必须走这里重开，不能热更新正在进行的一局。
  const start = useCallback(async () => {
    setStatus('loading')
    setErrorMsg(null)
    setHistory([])
    setEnding(null)
    setDeadEndInfo(null)
    setBlockedEvent(null)
    setCurrent(null)
    setTakenEdges([])
    undoStackRef.current = []
    sceneCacheRef.current = {}
    try {
      const [events, world] = await Promise.all([
        api.getData(projectId, 'events'),
        api.getData(projectId, 'world').catch(() => null), // world 可能未生成，不影响试玩，仅影响 speaker 解析
      ])
      const content = events?.content
      if (!content?.nodes?.length) {
        setErrorMsg(t('playtest.emptyGraph'))
        setStatus('error')
        return
      }
      const nodeById = Object.fromEntries(content.nodes.map((n) => [n.id, n]))
      const varById = Object.fromEntries((content.state_variables || []).map((v) => [v.id, v]))
      eventGraphRef.current = { nodes: content.nodes, edges: content.edges || [], nodeById, varById }
      worldCardIndexRef.current = buildWorldCardIndex(world?.content)
      locImageByIdRef.current = Object.fromEntries(
        (world?.content?.locations || []).map((l) => [l.id, l.image || '']),
      )
      charImageByIdRef.current = Object.fromEntries(
        (world?.content?.characters || []).map((c) => [c.id, c.image || '']),
      )
      locNameByIdRef.current = Object.fromEntries(
        (world?.content?.locations || []).map((l) => [l.id, l.name || l.id]),
      )
      const initial = initVars(content.state_variables)
      setVars(initial)
      const entry = findEntryNodeId(content.nodes.map((n) => n.id), content.edges || [])
      await enterEvent(entry, initial)
    } catch (err) {
      setErrorMsg(t('playtest.loadEventsFailed', { detail: err.message }))
      setStatus('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enterEvent, t])

  // 玩家选择某个出边（含"仅剩一条"时的"下一步"）。
  const choose = useCallback(
    async (edgeId) => {
      const pending = pendingRef.current
      const choice = choices.find((c) => c.id === edgeId)
      if (!pending || !choice || choice.disabled || isAdvancing) return
      setIsAdvancing(true)

      try {
        // 仅当存在 ≥2 个选项（玩家真正做了决定）时才回显"→ 选择"；单条"下一步"是线性推进、
        // 不是选择，不产生回显（否则会把线性边的空 label 回退成下一句内容的截断，形成噪音）。
        const isRealChoice = choices.length > 1

        // 转移前压快照，供 undo 还原。
        undoStackRef.current.push({
          pending: structuredClone ? structuredClone(pending) : { ...pending },
          vars: { ...vars },
          historyLen: history.length,
          status,
          choices,
          deadEndInfo,
          ending,
          blockedEvent,
          current,
          takenEdges,
        })

        if (pending.kind === 'event_boundary') {
          await advanceEvent(pending.eventId, vars)
          return
        }
        if (pending.kind === 'event_transition') {
          setTakenEdges((edges) => recordTakenEdge(edges, 'event', choice.edge?.id))
          if (isRealChoice) setHistory((h) => [...h, { kind: 'event_choice', label: choice.label }])
          await enterEvent(choice.edge.target, vars, { autoLabel: choice.edge.label })
          return
        }
        // kind === 'scene'：在当前情节图内走到下一个 beat。
        const { scene, eventId, node } = pending
        setTakenEdges((edges) => recordTakenEdge(edges, 'scene', choice.edge?.id))
        if (isRealChoice) setHistory((h) => [...h, { kind: 'beat_choice', label: choice.label }])
        const { outs, ok, nextVars } = await enterBeat(node, scene, choice.edge.target, vars)
        pendingRef.current = { kind: 'scene', eventId, scene, node }
        if (outs.length === 0) {
          // 与入口即终止的 scene 一致，终止内容保持到下一次点击。
          pendingRef.current = { kind: 'event_boundary', eventId }
          setStatus('playing')
          setDeadEndInfo(null)
          setChoices([{ id: `__event_boundary__:${eventId}`, label: t('playtest.enterNext'), kind: 'event_boundary', disabled: false }])
          return
        }
        if (ok.length === 0) {
          setDeadEndInfo(
            outs
              .filter((e) => e.condition)
              .map((e) => describeGap(e.condition, nextVars, eventGraphRef.current.varById, t))
              .join(t('playtest.gapSep')) || t('playtest.deadScene'),
          )
          setStatus('dead_end')
        } else {
          setStatus('playing')
          setDeadEndInfo(null)
        }
        setChoices(
          outs.map((e) => {
            const disabled = !evalCondition(e.condition, nextVars)
            return {
              id: e.id,
              label: e.label || (scene.beats.find((b) => b.id === e.target)?.content || '').slice(0, 16) || e.target,
              kind: 'beat',
              edge: e,
              disabled,
              disabledReason: disabled
                ? describeGap(e.condition, nextVars, eventGraphRef.current.varById, t)
                : null,
            }
          }),
        )
      } finally {
        setIsAdvancing(false)
      }
    },
    [choices, vars, history, status, deadEndInfo, ending, blockedEvent, current, takenEdges, isAdvancing, enterEvent, enterBeat, advanceEvent, t],
  )

  // 回退一步：从栈顶恢复快照（含"待选择"上下文与历史长度截断）。
  const undo = useCallback(() => {
    const snap = undoStackRef.current.pop()
    if (!snap) return
    pendingRef.current = snap.pending
    setVars(snap.vars)
    setHistory((h) => h.slice(0, snap.historyLen))
    setStatus(snap.status)
    setChoices(snap.choices)
    setDeadEndInfo(snap.deadEndInfo)
    setEnding(snap.ending)
    setBlockedEvent(snap.blockedEvent)
    setCurrent(snap.current || null)
    setTakenEdges(snap.takenEdges || [])
  }, [])

  return {
    status,
    errorMsg,
    history,
    vars,
    choices,
    deadEndInfo,
    ending,
    blockedEvent,
    canUndo,
    isAdvancing,
    varList: Object.values(varById),
    current,
    takenEdges,
    start,
    choose,
    undo,
  }
}
