/**
 * Agent 修改摘要的领域展示与定位规则。
 *
 * changeset 继续保存完整 before/after 作为确定性复核与撤销依据；本模块只负责把值转换为创作者可读文本，
 * 并明确区分“选中仍存在的对象”和“只打开已删除对象所属面板”。
 * 文案通过可选 `t` 本地化；缺省使用中文，保证现有检查与历史调用不变。
 */

import { tZh } from './i18n/translate.js'

/** 修改摘要顶部分类，以及意图/大纲行级差异标题用的面板名。 */
export const CHANGE_TYPE_LABELS = {
  intent: tZh('agent.change.types.intent'),
  outline: tZh('agent.change.types.outline'),
  world: tZh('agent.change.types.world'),
  events: tZh('agent.change.types.events'),
  scene: tZh('agent.change.types.scene'),
  asset: tZh('agent.change.types.asset'),
}

/**
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 */
function typeLabels(t) {
  return {
    intent: t('agent.change.types.intent'),
    outline: t('agent.change.types.outline'),
    world: t('agent.change.types.world'),
    events: t('agent.change.types.events'),
    scene: t('agent.change.types.scene'),
    asset: t('agent.change.types.asset'),
  }
}

function objectLabels(t) {
  return {
    text: t('agent.change.objects.text'),
    worldview: t('agent.change.objects.worldview'),
    character: t('agent.change.objects.character'),
    location: t('agent.change.objects.location'),
    faction: t('agent.change.objects.faction'),
    history: t('agent.change.objects.history'),
    other: t('agent.change.objects.other'),
    event: t('agent.change.objects.event'),
    event_edge: t('agent.change.objects.event_edge'),
    state_variable: t('agent.change.objects.state_variable'),
    scene: t('agent.change.objects.scene'),
    beat: t('agent.change.objects.beat'),
    scene_edge: t('agent.change.objects.scene_edge'),
    asset: t('agent.change.objects.asset'),
  }
}

function fieldLabels(t) {
  return {
    name: t('agent.change.fields.name'),
    title: t('agent.change.fields.title'),
    description: t('agent.change.fields.description'),
    summary: t('agent.change.fields.summary'),
    type: t('agent.change.fields.type'),
    kind: t('agent.change.fields.kind'),
    tags: t('agent.change.fields.tags'),
    image: t('agent.change.fields.image'),
    content: t('agent.change.fields.content'),
    speaker: t('agent.change.fields.speaker'),
    location: t('agent.change.fields.location'),
    characters: t('agent.change.fields.characters'),
    locations: t('agent.change.fields.locations'),
    source: t('agent.change.fields.source'),
    target: t('agent.change.fields.target'),
    label: t('agent.change.fields.label'),
    condition: t('agent.change.fields.condition'),
    effects: t('agent.change.fields.effects'),
    initial: t('agent.change.fields.initial'),
    allowed: t('agent.change.fields.allowed'),
    min: t('agent.change.fields.min'),
    max: t('agent.change.fields.max'),
    lines: t('agent.change.fields.lines'),
  }
}

/** 可当作对象显示名的字段；改这些字段本身时不要再用该值当标题里的名字。 */
const NAME_FIELDS = ['name', 'title', 'content', 'label']

function valueTypeLabels(t) {
  return {
    mainline: t('agent.change.typesValue.mainline'),
    optional: t('agent.change.typesValue.optional'),
    ending: t('agent.change.typesValue.ending'),
    narration: t('agent.change.typesValue.narration'),
    monologue: t('agent.change.typesValue.monologue'),
    dialogue: t('agent.change.typesValue.dialogue'),
    choice: t('agent.change.typesValue.choice'),
    flag: t('agent.change.typesValue.flag'),
    enum: t('agent.change.typesValue.enum'),
    scalar: t('agent.change.typesValue.scalar'),
  }
}

function operatorLabels(t) {
  return {
    '==': t('agent.change.ops.eq'),
    '!=': t('agent.change.ops.ne'),
    '>': t('agent.change.ops.gt'),
    '>=': t('agent.change.ops.gte'),
    '<': t('agent.change.ops.lt'),
    '<=': t('agent.change.ops.lte'),
    set: t('agent.change.ops.set'),
    add: t('agent.change.ops.add'),
  }
}

/**
 * 从对象上取一个可读名称。
 *
 * @param {unknown} value before/after 值。
 * @param {string | null | undefined} [skipField] 正在修改的字段，避免「改标题却用新标题当对象名」。
 * @returns {string} 名称；没有则空串。
 */
function objectName(value, skipField) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  for (const key of NAME_FIELDS) {
    if (key === skipField) continue
    const text = value[key]
    if (typeof text === 'string' && text.trim()) return text
  }
  if (typeof value.filename === 'string' && value.filename.trim()) return value.filename
  return ''
}

/** 把单个 condition 转为自然语言。 */
function formatCondition(value, t) {
  if (!value || typeof value !== 'object') return formatPrimitive(value, t)
  const variable = value.var || value.variable || t('agent.change.unspecifiedVar')
  const operator = operatorLabels(t)[value.op] || value.op || t('agent.change.ops.satisfy')
  return `${variable} ${operator} ${formatPrimitive(value.value, t)}`
}

/** 把单个 effect 转为自然语言。 */
function formatEffect(value, t) {
  if (!value || typeof value !== 'object') return formatPrimitive(value, t)
  const variable = value.var || value.variable || t('agent.change.unspecifiedVar')
  const operator = operatorLabels(t)[value.op] || value.op || t('agent.change.ops.become')
  return `${variable} ${operator} ${formatPrimitive(value.value, t)}`
}

/** 把基础值转为紧凑文本。 */
function formatPrimitive(value, t) {
  if (value === null || value === undefined) return t('common.none')
  if (value === '') return t('common.emptyText')
  if (value === true) return t('common.yes')
  if (value === false) return t('common.no')
  return valueTypeLabels(t)[value] || String(value)
}

/** 把普通对象按常用领域字段组织为逐行摘要。 */
function formatObject(value, detail, t) {
  const labels = fieldLabels(t)
  const objectType = detail.object_type
  if (objectType === 'scene') {
    const beats = Array.isArray(value.beats) ? value.beats : []
    const edges = Array.isArray(value.edges) ? value.edges : []
    const opening = objectName(beats[0])
    return [
      t('agent.change.sceneSummary', { beats: beats.length, edges: edges.length }),
      ...(opening ? [t('agent.change.sceneOpening', { opening })] : []),
    ].join('\n')
  }
  if (objectType === 'asset') {
    return t('agent.change.assetSummary', {
      filename: value.filename || detail.object_id || t('agent.change.unknownFile'),
      digest: value.sha256 ? `${value.sha256.slice(0, 12)}…` : t('common.none'),
    })
  }
  if (detail.field === 'condition' || ('var' in value && 'op' in value && !('id' in value))) {
    return formatCondition(value, t)
  }

  const preferredFields = objectType === 'beat'
    ? ['kind', 'content', 'speaker', 'location', 'effects']
    : objectType === 'event' || objectType === 'event_edge' || objectType === 'scene_edge'
      ? ['title', 'summary', 'type', 'source', 'target', 'label', 'condition', 'characters', 'locations']
      : objectType === 'state_variable'
        ? ['name', 'type', 'description', 'initial', 'allowed', 'min', 'max']
        : ['name', 'description', 'tags', 'image']

  const lines = []
  for (const field of preferredFields) {
    if (!(field in value)) continue
    const fieldValue = value[field]
    if (field === 'condition') {
      lines.push(`${labels[field]}：${formatCondition(fieldValue, t)}`)
    } else if (field === 'effects') {
      const effects = Array.isArray(fieldValue) ? fieldValue : []
      lines.push(`${labels[field]}：${effects.length ? effects.map((item) => formatEffect(item, t)).join('；') : t('common.none')}`)
    } else if (Array.isArray(fieldValue)) {
      lines.push(`${labels[field] || field}：${fieldValue.length ? fieldValue.map((item) => formatPrimitive(item, t)).join('、') : t('common.none')}`)
    } else {
      lines.push(`${labels[field] || field}：${formatPrimitive(fieldValue, t)}`)
    }
  }
  return lines.length ? lines.join('\n') : t('agent.change.structuredChanged')
}

/**
 * 把一侧差异值格式化为默认可读文本。
 *
 * @param {object} detail changeset 的单条差异。
 * @param {unknown} value before 或 after。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {string} 创作者可读摘要。
 */
export function formatChangeValue(detail, value, t = tZh) {
  if (value === null || value === undefined) return t('common.none')
  if (typeof value !== 'object') return formatPrimitive(value, t)
  if (Array.isArray(value)) {
    if (detail.field === 'effects') return value.length ? value.map((item) => formatEffect(item, t)).join('\n') : t('common.none')
    if (detail.field === 'condition') return value.length ? value.map((item) => formatCondition(item, t)).join('\n') : t('common.none')
    return value.length ? value.map((item) => formatPrimitive(item, t)).join('、') : t('common.none')
  }
  return formatObject(value, detail, t)
}

/**
 * 返回差异标题中的领域对象与字段名称。
 *
 * 意图/大纲的行级差异写成「创作意图的一段」，不把内部 text/lines 译成「文本的文本」。
 *
 * @param {object} detail changeset 的单条差异。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {string} 不含新增/删除/修改动词的标题。
 */
export function changeDetailLabel(detail, t = tZh) {
  const types = typeLabels(t)
  const objects = objectLabels(t)
  const fields = fieldLabels(t)
  if (detail.object_type === 'text' || detail.field === 'lines') {
    const board = types[detail.data_type]
    return board ? t('agent.change.boardPassage', { board }) : t('agent.change.textPassage')
  }

  const objectLabel = objects[detail.object_type] || types[detail.data_type] || t('common.content')
  const fieldLabel = detail.field && fields[detail.field]
  const value = detail.after ?? detail.before
  const name = objectName(value, detail.field)
    || (detail.object_type === 'asset' ? (detail.object_id || '') : '')
  const named = name ? t('agent.change.quotedName', { object: objectLabel, name: String(name).slice(0, 30) }) : objectLabel
  if (!fieldLabel || fieldLabel === objectLabel) return named
  return t('agent.change.namedField', { named, field: fieldLabel })
}

/**
 * 判断定位按钮的文案与行为。
 *
 * 删除项只能打开所属面板；资产没有稳定的卡片归属，暂不提供伪定位。
 * @param {object} detail changeset 的单条差异。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {{enabled: boolean, label: string, selectObject: boolean}}
 */
export function changeNavigation(detail, t = tZh) {
  if (detail.object_type === 'asset') {
    return { enabled: false, label: '', selectObject: false }
  }
  if (detail.operation === 'remove') {
    return { enabled: true, label: t('agent.change.openPanel'), selectObject: false }
  }
  return {
    enabled: true,
    label: detail.object_type === 'scene' ? t('agent.change.openScene') : t('agent.change.locate'),
    selectObject: detail.object_type !== 'scene',
  }
}

/** 返回完整原始值，供默认收起的精确复核区使用。 */
export function rawChangeValue(value, t = tZh) {
  if (value === null || value === undefined) return t('common.none')
  if (typeof value === 'string') return value || t('common.emptyText')
  return JSON.stringify(value, null, 2)
}
