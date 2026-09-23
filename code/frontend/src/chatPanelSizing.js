/**
 * 右侧 Agent 面板宽度常量与夹取规则。
 * 偏好写入浏览器后仍按当前视口和左侧栏占用临时夹住显示宽度，不回写偏好。
 */

/** 首次访问与双击 / Home 重置后的展开宽度。 */
export const CHAT_PANEL_DEFAULT_WIDTH = 380

/** 展开态允许的最小宽度。 */
export const CHAT_PANEL_MIN_WIDTH = 320

/** 展开态允许的绝对最大宽度。 */
export const CHAT_PANEL_MAX_WIDTH = 720

/** 折叠窄栏宽度，与现有 CSS 一致。 */
export const CHAT_PANEL_COLLAPSED_WIDTH = 48

/** 尽量为中间构建/试玩区保留的最小宽度。 */
export const CHAT_PANEL_CENTER_MIN_WIDTH = 480

/** 键盘左右方向键的调整步长。 */
export const CHAT_PANEL_KEYBOARD_STEP = 16

/** 左侧项目栏展开宽度，用于估算中间区剩余空间。 */
export const SIDEBAR_EXPANDED_WIDTH = 280

/** 左侧项目栏折叠宽度。 */
export const SIDEBAR_COLLAPSED_WIDTH = 48

/** 浏览器本地存储中的宽度偏好键。 */
export const CHAT_WIDTH_STORAGE_KEY = 'gflow.layout.chatWidth'

/**
 * 解析本地存储中的宽度字符串。
 *
 * @param {string|null|undefined} raw 存储值。
 * @returns {number|null} 合法数字，否则 null。
 */
export function parseStoredChatWidth(raw) {
  if (raw == null || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.round(value)
}

/**
 * 把偏好宽度夹到绝对上下限。非法输入回退到默认宽度。
 *
 * @param {number} width 用户偏好或拖拽结果。
 * @returns {number} 320–720 之间的整数。
 */
export function clampPreferredChatWidth(width) {
  const value = Math.round(Number(width))
  if (!Number.isFinite(value)) return CHAT_PANEL_DEFAULT_WIDTH
  return Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, value))
}

/**
 * 当前左侧栏占用的像素宽度。
 *
 * @param {boolean} sidebarCollapsed 左侧栏是否折叠。
 * @returns {number}
 */
export function sidebarOccupiedWidth(sidebarCollapsed) {
  return sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH
}

/**
 * 当前视口下展开态可显示的最小/最大宽度。
 * 中间区不够时仍至少允许最小宽度，避免面板比 320px 更窄。
 *
 * @param {object} layout
 * @param {number} layout.viewportWidth 窗口宽度。
 * @param {boolean} layout.sidebarCollapsed 左侧栏是否折叠。
 * @returns {{min: number, max: number}}
 */
export function chatPanelWidthBounds({ viewportWidth, sidebarCollapsed }) {
  const min = CHAT_PANEL_MIN_WIDTH
  const vw = Number(viewportWidth)
  const safeViewport = Number.isFinite(vw) && vw > 0 ? vw : 1920
  const available = Math.floor(
    safeViewport - sidebarOccupiedWidth(sidebarCollapsed) - CHAT_PANEL_CENTER_MIN_WIDTH,
  )
  const max = Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(min, available))
  return { min, max }
}

/**
 * 按当前布局计算实际显示宽度。只夹显示值，不改偏好。
 *
 * @param {number} preferredWidth 已保存的偏好。
 * @param {{viewportWidth: number, sidebarCollapsed: boolean}} layout 当前布局。
 * @returns {number} 实际用于展开态的像素宽度。
 */
export function clampDisplayedChatWidth(preferredWidth, layout) {
  const preferred = clampPreferredChatWidth(preferredWidth)
  const { min, max } = chatPanelWidthBounds(layout)
  return Math.min(max, Math.max(min, preferred))
}

/**
 * 根据指针位移计算新的偏好宽度。面板在右侧，向左拖增加宽度。
 *
 * @param {object} params
 * @param {number} params.startWidth 按下时的显示宽度。
 * @param {number} params.startX 按下时的 clientX。
 * @param {number} params.clientX 当前 clientX。
 * @returns {number} 夹到绝对上下限后的偏好。
 */
export function nextChatWidthFromPointer({ startWidth, startX, clientX }) {
  return clampPreferredChatWidth(startWidth + (startX - clientX))
}

/**
 * 根据键盘按键调整宽度。ArrowLeft 加宽，ArrowRight 变窄，Home 恢复默认。
 *
 * @param {number} currentWidth 当前显示宽度。
 * @param {string} key 按键名。
 * @returns {number} 新的偏好宽度；无关按键原样返回当前值。
 */
export function nextChatWidthFromKeyboard(currentWidth, key) {
  if (key === 'Home') return CHAT_PANEL_DEFAULT_WIDTH
  if (key === 'ArrowLeft') return clampPreferredChatWidth(currentWidth + CHAT_PANEL_KEYBOARD_STEP)
  if (key === 'ArrowRight') return clampPreferredChatWidth(currentWidth - CHAT_PANEL_KEYBOARD_STEP)
  return currentWidth
}
