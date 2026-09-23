/**
 * 按功能域合并 zh-CN / en-US 字典。
 */

import { common } from './common.js'
import { workspace } from './workspace.js'
import { agent } from './agent.js'
import { artifacts } from './artifacts.js'
import { events } from './events.js'
import { validation } from './validation.js'
import { playtest } from './playtest.js'
import { help } from './help.js'

const domains = { common, workspace, agent, artifacts, events, validation, playtest, help }

/**
 * @param {'zh-CN'|'en-US'} locale
 * @returns {Record<string, unknown>}
 */
function mergeLocale(locale) {
  const merged = {}
  for (const [name, domain] of Object.entries(domains)) {
    merged[name] = domain[locale]
  }
  return merged
}

export const dictionaries = {
  'zh-CN': mergeLocale('zh-CN'),
  'en-US': mergeLocale('en-US'),
}
