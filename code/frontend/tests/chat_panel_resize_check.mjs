/**
 * 右侧 Agent 面板拖拽调宽、视口夹取与无障碍契约检查。
 *
 * 运行：node tests/chat_panel_resize_check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_PANEL_CENTER_MIN_WIDTH,
  CHAT_PANEL_COLLAPSED_WIDTH,
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_KEYBOARD_STEP,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_WIDTH_STORAGE_KEY,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
  chatPanelWidthBounds,
  clampDisplayedChatWidth,
  clampPreferredChatWidth,
  nextChatWidthFromKeyboard,
  nextChatWidthFromPointer,
  parseStoredChatWidth,
  sidebarOccupiedWidth,
} from '../src/chatPanelSizing.js'

const root = dirname(fileURLToPath(import.meta.url))
const chatSource = readFileSync(join(root, '../src/components/ChatPanel.jsx'), 'utf8')
const appSource = readFileSync(join(root, '../src/App.jsx'), 'utf8')
const cssSource = readFileSync(join(root, '../src/styles.css'), 'utf8')
const agentDict = readFileSync(join(root, '../src/i18n/dictionaries/agent.js'), 'utf8')

assert.equal(CHAT_PANEL_DEFAULT_WIDTH, 380, '默认展开宽度保持 380px')
assert.equal(CHAT_PANEL_MIN_WIDTH, 320)
assert.equal(CHAT_PANEL_MAX_WIDTH, 720)
assert.equal(CHAT_PANEL_COLLAPSED_WIDTH, 48)
assert.equal(CHAT_WIDTH_STORAGE_KEY, 'gflow.layout.chatWidth')
assert.equal(sidebarOccupiedWidth(false), SIDEBAR_EXPANDED_WIDTH)
assert.equal(sidebarOccupiedWidth(true), SIDEBAR_COLLAPSED_WIDTH)

assert.equal(parseStoredChatWidth(null), null)
assert.equal(parseStoredChatWidth('abc'), null)
assert.equal(parseStoredChatWidth('480.7'), 481)
assert.equal(clampPreferredChatWidth(200), 320, '偏好不低于 320')
assert.equal(clampPreferredChatWidth(900), 720, '偏好不超过 720')
assert.equal(clampPreferredChatWidth('bad'), 380, '非法偏好回退默认值')

const wide = { viewportWidth: 1600, sidebarCollapsed: false }
assert.deepEqual(chatPanelWidthBounds(wide), { min: 320, max: 720 })
assert.equal(clampDisplayedChatWidth(600, wide), 600)

const narrow = { viewportWidth: 1280, sidebarCollapsed: false }
const narrowMax = 1280 - SIDEBAR_EXPANDED_WIDTH - CHAT_PANEL_CENTER_MIN_WIDTH
assert.equal(chatPanelWidthBounds(narrow).max, narrowMax)
assert.equal(clampDisplayedChatWidth(720, narrow), narrowMax, '窄视口只夹显示宽度')
assert.equal(clampPreferredChatWidth(720), 720, '窄视口不覆盖已保存偏好')

const cramped = { viewportWidth: 900, sidebarCollapsed: false }
assert.equal(clampDisplayedChatWidth(500, cramped), 320, '中间区不够时仍保持最小展开宽度')

assert.equal(
  nextChatWidthFromPointer({ startWidth: 380, startX: 500, clientX: 420 }),
  460,
  '向左拖增加宽度',
)
assert.equal(
  nextChatWidthFromPointer({ startWidth: 380, startX: 500, clientX: 700 }),
  320,
  '向右拖变窄并停在下限',
)
assert.equal(nextChatWidthFromKeyboard(380, 'ArrowLeft'), 380 + CHAT_PANEL_KEYBOARD_STEP)
assert.equal(nextChatWidthFromKeyboard(380, 'ArrowRight'), 380 - CHAT_PANEL_KEYBOARD_STEP)
assert.equal(nextChatWidthFromKeyboard(500, 'Home'), 380, 'Home 恢复默认宽度')
assert.equal(nextChatWidthFromKeyboard(500, 'Enter'), 500)

assert.match(appSource, /CHAT_WIDTH_STORAGE_KEY/, 'App 持久化宽度偏好')
assert.match(appSource, /clampDisplayedChatWidth/, '视口夹取只影响显示宽度')
assert.match(appSource, /onWidthChange=\{updateChatWidth\}/, '拖拽结果写回偏好')
assert.match(chatSource, /role="separator"/, '分隔条使用 separator')
assert.match(chatSource, /aria-orientation="vertical"/)
assert.match(chatSource, /aria-valuenow=\{width\}/)
assert.match(chatSource, /aria-valuemin=\{rangeMin\}/)
assert.match(chatSource, /aria-valuemax=\{rangeMax\}/)
assert.match(chatSource, /setPointerCapture/, '拖拽使用指针捕获')
assert.match(chatSource, /onDoubleClick=\{resetWidth\}/, '双击恢复默认宽度')
assert.match(chatSource, /event\.key === 'Home'/, '键盘 Home 恢复默认')
assert.match(chatSource, /canResize = !collapsed/, '折叠时不显示分隔条')
assert.match(chatSource, /--chat-panel-width/, '展开宽度走 CSS 变量')
assert.match(cssSource, /width: var\(--chat-panel-width, 380px\)/)
assert.match(cssSource, /\.chat\.is-collapsed \{[\s\S]*?width: 48px/, '折叠仍固定 48px')
assert.match(cssSource, /\.chat\.is-resizing \{[\s\S]*?transition: none/, '拖拽时关闭宽度过渡')
assert.match(cssSource, /cursor: col-resize/)
assert.match(agentDict, /resizeHandle: '调整 Agent 面板宽度'/)
assert.match(agentDict, /resizeHandle: 'Resize the Agent panel'/)
assert.match(agentDict, /resetWidth: '双击或按 Home 恢复默认宽度'/)
assert.match(agentDict, /Double-click or press Home to restore the default width/)

console.log('chat_panel_resize_check: width bounds, persistence, keyboard and a11y contracts hold')
