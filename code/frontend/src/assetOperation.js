/**
 * 角色/地点卡片配图操作的文案与状态。
 * 见 DESIGN §5.8：上传/更换与生成/重新生成共用两条后端路径，界面仍用四类准确说法。
 */

import { tZh } from './i18n/translate.js'

/**
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 */
export function assetOperationActions(t = tZh) {
  return {
    upload: { verb: t('agent.asset.upload.verb'), buttonBusy: t('agent.asset.upload.busy'), buttonIdle: t('agent.asset.upload.idle') },
    replace: { verb: t('agent.asset.replace.verb'), buttonBusy: t('agent.asset.replace.busy'), buttonIdle: t('agent.asset.replace.idle') },
    generate: { verb: t('agent.asset.generate.verb'), buttonBusy: t('agent.asset.generate.busy'), buttonIdle: t('agent.asset.generate.idle') },
    regenerate: { verb: t('agent.asset.regenerate.verb'), buttonBusy: t('agent.asset.regenerate.busy'), buttonIdle: t('agent.asset.regenerate.idle') },
  }
}

/** 四种界面操作：动词用于全局条，按钮用于卡片抽屉。默认中文，供现有检查使用。 */
export const ASSET_OPERATION_ACTIONS = assetOperationActions()

/**
 * 把卡片分类写成创作者能看懂的种类名。
 *
 * @param {'characters'|'locations'|string} category 设定子类型。
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {string}
 */
export function assetOperationKindLabel(category, t = tZh) {
  return category === 'locations' ? t('artifacts.cards.location') : t('artifacts.cards.character')
}

/**
 * 选择本地文件时：已有图是更换，否则是上传。
 *
 * @param {boolean} hasImage 当前草稿是否已有配图路径。
 * @returns {'replace'|'upload'}
 */
export function resolveAssetFileAction(hasImage) {
  return hasImage ? 'replace' : 'upload'
}

/**
 * 点生图按钮时：已有图是重新生成，否则是一键生图。
 *
 * @param {boolean} hasImage 当前草稿是否已有配图路径。
 * @returns {'regenerate'|'generate'}
 */
export function resolveAssetGenerateAction(hasImage) {
  return hasImage ? 'regenerate' : 'generate'
}

/**
 * 组成进行中状态的主句，不含等待时间。
 *
 * @param {object} operation
 * @param {'characters'|'locations'|string} operation.category
 * @param {string} [operation.cardName]
 * @param {keyof ReturnType<typeof assetOperationActions>} operation.action
 * @param {(key: string, vars?: Record<string, unknown>) => string} [t]
 * @returns {string}
 */
export function formatAssetOperationLabel({ category, cardName, action } = {}, t = tZh) {
  const kind = assetOperationKindLabel(category, t)
  const name = String(cardName || '').trim() || t('common.unnamed')
  const verb = assetOperationActions(t)[action]?.verb || t('agent.asset.process')
  return t('agent.asset.running', { kind, name, verb })
}

/**
 * 把开始时刻格式成秒级等待说明。
 *
 * @param {number} startedAt Date.now() 毫秒时间戳。
 * @param {number} [now]
 * @returns {string}
 */
export function formatAssetOperationWait(startedAt, now = Date.now(), t = tZh) {
  const elapsed = Number(startedAt) ? now - startedAt : 0
  const seconds = Math.max(0, Math.floor(elapsed / 1000))
  return t('agent.asset.waited', { seconds })
}

/**
 * 项目标题下状态条的完整文案。
 *
 * @param {object|null|undefined} operation
 * @param {number} [now]
 * @returns {string}
 */
export function formatAssetOperationStatus(operation, now = Date.now(), t = tZh) {
  if (!operation) return ''
  return `${formatAssetOperationLabel(operation, t)} · ${formatAssetOperationWait(operation.startedAt, now, t)}`
}

/**
 * Agent 输入框在配图进行中的说明，与状态条同一原因。
 *
 * @param {object|null|undefined} operation
 * @returns {string}
 */
export function formatAssetOperationBusyReason(operation, t = tZh) {
  if (!operation) return ''
  return t('agent.asset.busyChat', { label: formatAssetOperationLabel(operation, t) })
}
