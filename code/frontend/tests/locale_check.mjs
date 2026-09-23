/**
 * 语言解析、字典对齐与标签编辑。
 *
 * 运行：npm run check:locale
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dictionaries } from '../src/i18n/dictionaries/index.js'
import { createTranslator, tZh } from '../src/i18n/translate.js'
import {
  DEFAULT_LOCALE,
  detectBrowserLocale,
  resolveLocale,
  normalizeLocale,
} from '../src/i18n/locales.js'

function collectKeys(value, prefix = '') {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  return Object.entries(value).flatMap(([key, child]) => (
    collectKeys(child, prefix ? `${prefix}.${key}` : key)
  ))
}

const zhKeys = collectKeys(dictionaries['zh-CN']).sort()
const enKeys = collectKeys(dictionaries['en-US']).sort()
assert.deepEqual(zhKeys, enKeys, 'zh-CN / en-US 字典必须有相同的稳定 key')
assert.ok(zhKeys.includes('workspace.tabs.events'), '工作区标签必须在字典中')
assert.ok(zhKeys.includes('agent.chat.send'), 'Agent 面板必须在字典中')
assert.ok(zhKeys.includes('playtest.start'), '试玩文案必须在字典中')

const tEn = createTranslator('en-US')
assert.equal(tZh('workspace.tabs.events'), '事件')
assert.equal(tEn('workspace.tabs.events'), 'Events')
assert.equal(tZh('agent.chat.turnChanges', { count: 3 }), '本轮修改 3 处')
assert.equal(tEn('agent.chat.turnChanges', { count: 3 }), '3 changes this turn')
assert.notEqual(tEn('help.overlay.progress'), tZh('help.overlay.progress'))

assert.equal(normalizeLocale('en-US'), 'en-US')
assert.equal(normalizeLocale('fr-FR'), DEFAULT_LOCALE)
assert.equal(detectBrowserLocale('en-GB'), 'en-US')
assert.equal(detectBrowserLocale('zh-CN'), DEFAULT_LOCALE)

globalThis.window = { localStorage: { getItem: () => 'en-US' } }
assert.equal(resolveLocale(), 'en-US')
delete globalThis.window

const tagEditorSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/components/fields/TagEditor.jsx'),
  'utf8',
)
assert.match(tagEditorSource, /const t = useT\(\)/, 'TagEditor 使用翻译函数 t')
assert.match(tagEditorSource, /tags\.map\(\(tag, i\) =>/, '非空标签循环不得遮蔽翻译函数 t')
assert.match(
  tagEditorSource,
  /aria-label=\{t\('common\.delete'\)\}/,
  '可编辑删除按钮仍走翻译函数，不能对标签字符串调用 t()',
)
assert.match(tagEditorSource, /const tag = draft\.trim\(\)/, '提交新标签也不覆盖翻译函数 t')
assert.doesNotMatch(
  tagEditorSource,
  /tags\.map\(\(t,/,
  '标签循环参数不能再叫 t，否则打开带标签的卡片会白屏',
)

console.log(`locale_check: ${zhKeys.length} keys aligned, locale checks passed`)
