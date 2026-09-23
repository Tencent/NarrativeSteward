/**
 * 试玩舞台配图呈现：有真实卡片图才用图，缺图或加载失败则用名称占位。
 * 见 DESIGN §5.8。不使用内置默认场景/立绘，避免被当成作品配图。
 */

import { tZh } from './i18n/translate.js'

/**
 * 地点未挂图或加载失败时的舞台提示。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 */
export function playtestMissingLocationArt(t = tZh) {
  return t('artifacts.missingImage.location')
}

/**
 * 对话/独白角色未挂图或加载失败时的舞台提示。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 */
export function playtestMissingCharacterArt(t = tZh) {
  return t('artifacts.missingImage.character')
}

/** 默认中文提示，供现有 Node 检查与无 locale 调用使用。 */
export const PLAYTEST_MISSING_LOCATION_ART = playtestMissingLocationArt()

/** 默认中文提示，供现有 Node 检查与无 locale 调用使用。 */
export const PLAYTEST_MISSING_CHARACTER_ART = playtestMissingCharacterArt()

/**
 * 根据地点/角色是否真正加载到图片，决定舞台背景、立绘和缺图提示。
 *
 * @param {object} input
 * @param {string} [input.locationName] 地点卡片显示名；无地点时为空。
 * @param {string} [input.bgImage] 已成功加载的地点图 URL；没有则为空。
 * @param {boolean} [input.isSpeech] 当前 beat 是否为带说话人的对话或独白。
 * @param {string} [input.speakerName] 说话人显示名。
 * @param {boolean} [input.isCharacterSpeaker] 是否为角色发言者；只有角色才显示立绘或缺图提示。
 * @param {string} [input.charImage] 已成功加载的角色立绘 URL；没有则为空。
 * @returns {{
 *   bgImage: string,
 *   charImage: string,
 *   missingLocationImage: boolean,
 *   missingCharacterImage: boolean,
 * }}
 */
export function playtestVisuals({
  locationName = '',
  bgImage = '',
  isSpeech = false,
  speakerName = '',
  isCharacterSpeaker = false,
  charImage = '',
} = {}) {
  const hasBg = Boolean(bgImage)
  const showPortrait = Boolean(isSpeech && isCharacterSpeaker)
  const hasPortrait = Boolean(showPortrait && charImage)
  return {
    bgImage: hasBg ? bgImage : '',
    charImage: hasPortrait ? charImage : '',
    missingLocationImage: Boolean(locationName) && !hasBg,
    missingCharacterImage: Boolean(showPortrait && speakerName) && !hasPortrait,
  }
}
