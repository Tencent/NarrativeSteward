/**
 * Agent 对话输入框按内容增高、封顶滚动与折叠后重测的契约检查。
 *
 * 运行：node tests/chat_input_autogrow_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTO_GROW_FIXED_CAP_PX,
  clampAutoGrowHeight,
  resolveAutoGrowMaxHeight,
  shouldSkipAutoGrowMeasure,
} from '../src/hooks/useAutoGrowTextarea.js'

const root = dirname(fileURLToPath(import.meta.url))
const chatSource = readFileSync(join(root, '../src/components/ChatPanel.jsx'), 'utf8')
const fieldSource = readFileSync(join(root, '../src/components/fields/TextFieldRow.jsx'), 'utf8')
const hookSource = readFileSync(join(root, '../src/hooks/useAutoGrowTextarea.js'), 'utf8')
const cssSource = readFileSync(join(root, '../src/styles.css'), 'utf8')

assert.equal(resolveAutoGrowMaxHeight(320), 320, '表单字段保持 320px 固定上限')
assert.equal(resolveAutoGrowMaxHeight(200), 200, '调用方可传入更小的固定上限')
assert.equal(
  resolveAutoGrowMaxHeight('viewport-cap', 1000),
  AUTO_GROW_FIXED_CAP_PX,
  '高视口上对话输入仍不超过 320px',
)
assert.equal(
  resolveAutoGrowMaxHeight('viewport-cap', 600),
  240,
  '矮视口上对话输入按 40vh 封顶',
)
assert.equal(
  resolveAutoGrowMaxHeight('viewport-cap', 0),
  AUTO_GROW_FIXED_CAP_PX,
  '视口未知时回退到 320px',
)

assert.equal(clampAutoGrowHeight(80, 320), 80, '短文本只占所需高度')
assert.equal(clampAutoGrowHeight(40, 320), 40, '删减后高度跟着缩回')
assert.equal(clampAutoGrowHeight(500, 320), 320, '超过上限后不再继续增高')
assert.equal(clampAutoGrowHeight(500, 240), 240, '矮视口上限同样截断并交给内部滚动')

assert.equal(shouldSkipAutoGrowMeasure(null, true), true, '未挂载不测量')
assert.equal(shouldSkipAutoGrowMeasure({ offsetParent: {} }, false), true, '折叠或禁用时不测量')
assert.equal(shouldSkipAutoGrowMeasure({ offsetParent: null }, true), true, '隐藏字段不测量，避免塌成 0')
assert.equal(shouldSkipAutoGrowMeasure({ offsetParent: {} }, true), false, '可见且启用时才测量')

assert.match(hookSource, /ResizeObserver/, '宽度变化时重新测量换行高度')
assert.match(chatSource, /useAutoGrowTextarea/, '对话输入复用公共自适应高度 hook')
assert.match(chatSource, /maxHeight: 'viewport-cap'/, '对话输入按 min(320px, 40vh) 封顶')
assert.match(chatSource, /enabled: !collapsed/, '折叠窄栏时不按错误宽度测量')
assert.match(chatSource, /result\?\.accepted/, '发送被接受后才清空，高度随之回到最小')
assert.match(chatSource, /e\.key === 'Enter' && !e\.shiftKey/, 'Enter 发送 / Shift+Enter 换行保持不变')
assert.match(fieldSource, /useAutoGrowTextarea/, '表单多行框改走同一 hook')
assert.match(fieldSource, /maxHeight = 320/, '表单默认上限仍是 320px')
assert.match(cssSource, /\.chat-input \{[\s\S]*?flex-shrink: 0/, '输入区不被 flex 压缩')
assert.match(cssSource, /max-height: min\(320px, 40vh\)/, '样式上限与 hook 一致')
assert.match(cssSource, /\.chat-input textarea \{[\s\S]*?overflow-y: auto/, '超限后只在输入框内滚动')

console.log('chat_input_autogrow_check: grow/shrink/cap/collapse remasure contracts hold')
