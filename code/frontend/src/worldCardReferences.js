/**
 * 世界设定六类卡片的公共索引与发言者解析。
 *
 * 情节 `speaker` 只允许六类设定中全局唯一的卡片 id；界面存 id、显示卡片名称。
 * 只有 `characters` 有立绘资格。未知或歧义 id 显示「未识别发言者」，不回退成角色名。
 * 见 DESIGN §4.5 / §5.8。
 */

import { tZh } from './i18n/translate.js'

/** 六类设定键 → artifacts.cards 字典键。 */
const CATEGORY_CARD_KEYS = {
  worldview: 'worldview',
  characters: 'character',
  locations: 'location',
  factions: 'faction',
  history: 'history',
  other: 'other',
}

/**
 * 读取某一类设定卡片的显示名。
 *
 * @param {string} categoryKey world.json 分类键。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {string}
 */
export function worldCardCategoryLabel(categoryKey, t = tZh) {
  const cardKey = CATEGORY_CARD_KEYS[categoryKey]
  return cardKey ? t(`artifacts.cards.${cardKey}`) : categoryKey
}

/** 与后端 WorldSetting 对齐的六类设定。缺省中文，供现有检查与未传 t 的调用使用。 */
export const WORLD_CARD_CATEGORIES = [
  { key: 'worldview', label: tZh('artifacts.cards.worldview') },
  { key: 'characters', label: tZh('artifacts.cards.character') },
  { key: 'locations', label: tZh('artifacts.cards.location') },
  { key: 'factions', label: tZh('artifacts.cards.faction') },
  { key: 'history', label: tZh('artifacts.cards.history') },
  { key: 'other', label: tZh('artifacts.cards.other') },
]

/** 六类设定键，顺序与表单 sub-tab 一致。 */
export const WORLD_CARD_CATEGORY_KEYS = WORLD_CARD_CATEGORIES.map((item) => item.key)

/** 可配图的设定分类：角色立绘、地点背景。 */
export const WORLD_IMAGE_CATEGORIES = new Set(['characters', 'locations'])

/** 唯一有立绘资格的设定分类。 */
export const SPEAKER_PORTRAIT_CATEGORY = 'characters'

/** 未知或歧义卡片 id 时的友好显示名（中文默认，供现有检查比较）。 */
export const UNKNOWN_SPEAKER_LABEL = tZh('artifacts.speaker.unrecognized')

/**
 * 从 world 内容建立六类卡片索引，供设定面板与 speaker 解析共用。
 *
 * @param {object|null|undefined} world `world.json` 内容。
 * @returns {{
 *   cards: Array<{id: string, name: string, category: string, image: string}>,
 *   byId: Map<string, Array<{id: string, name: string, category: string, image: string}>>,
 * }}
 */
export function buildWorldCardIndex(world) {
  const cards = []
  const byId = new Map()
  for (const key of WORLD_CARD_CATEGORY_KEYS) {
    const group = world?.[key]
    if (!Array.isArray(group)) continue
    for (const card of group) {
      if (!card || typeof card !== 'object') continue
      const entry = {
        id: String(card.id || ''),
        name: String(card.name || ''),
        category: key,
        image: String(card.image || ''),
      }
      cards.push(entry)
      if (entry.id) {
        const idList = byId.get(entry.id) || []
        idList.push(entry)
        byId.set(entry.id, idList)
      }
    }
  }
  return { cards, byId }
}

/**
 * @param {string} raw
 * @param {string} displayName
 * @param {object} extra
 */
function speakerResult(raw, displayName, extra = {}) {
  return {
    raw,
    displayName,
    category: extra.category ?? null,
    cardId: extra.cardId ?? null,
    resolved: Boolean(extra.resolved),
    isCharacterSpeaker: Boolean(extra.isCharacterSpeaker),
    unknown: Boolean(extra.unknown),
    unknownInternalId: Boolean(extra.unknown || extra.unknownInternalId),
    ambiguous: Boolean(extra.ambiguous),
  }
}

/**
 * 按精确卡片 id 解析情节 speaker，用于显示名和立绘资格。
 *
 * @param {string|null|undefined} raw 原始 speaker 字符串（应为卡片 id）。
 * @param {ReturnType<typeof buildWorldCardIndex>|null|undefined} index 世界卡片索引。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {{
 *   raw: string,
 *   displayName: string,
 *   category: string|null,
 *   cardId: string|null,
 *   resolved: boolean,
 *   isCharacterSpeaker: boolean,
 *   unknown: boolean,
 *   unknownInternalId: boolean,
 *   ambiguous: boolean,
 * }}
 */
export function resolveSpeakerReference(raw, index, t = tZh) {
  const speaker = String(raw || '').trim()
  const unknownLabel = t('artifacts.speaker.unrecognized')
  if (!speaker) {
    return speakerResult('', '')
  }
  const idMatches = index?.byId?.get(speaker) || []
  if (idMatches.length === 1) {
    const card = idMatches[0]
    return speakerResult(speaker, card.name || speaker, {
      category: card.category,
      cardId: card.id,
      resolved: true,
      isCharacterSpeaker: card.category === SPEAKER_PORTRAIT_CATEGORY,
    })
  }
  if (idMatches.length > 1) {
    return speakerResult(speaker, unknownLabel, {
      cardId: speaker,
      ambiguous: true,
    })
  }
  return speakerResult(speaker, unknownLabel, {
    unknown: true,
    unknownInternalId: true,
  })
}

/**
 * 发言人下拉选项：显示「名称（分类）」，值为卡片 id。
 *
 * @param {ReturnType<typeof buildWorldCardIndex>} index 世界卡片索引。
 * @param {string} [currentId] 当前已保存的 speaker；若不在选项中则追加损坏数据项。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t] 翻译函数，缺省中文。
 * @returns {Array<{value: string, label: string}>}
 */
export function speakerSelectOptions(index, currentId = '', t = tZh) {
  const options = [{ value: '', label: t('artifacts.speaker.choose') }]
  const seen = new Set()
  for (const card of index?.cards || []) {
    if (!card.id || seen.has(card.id)) continue
    seen.add(card.id)
    const categoryLabel = worldCardCategoryLabel(card.category, t)
    options.push({
      value: card.id,
      label: t('artifacts.speaker.namedCategory', {
        name: card.name || card.id,
        category: categoryLabel,
      }),
    })
  }
  const current = String(currentId || '').trim()
  if (current && !seen.has(current)) {
    options.push({
      value: current,
      label: t('artifacts.speaker.unrecognizedId', {
        label: t('artifacts.speaker.unrecognized'),
        id: current,
      }),
    })
  }
  return options
}
