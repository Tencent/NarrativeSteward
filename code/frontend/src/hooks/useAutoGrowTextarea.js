import { useEffect, useRef } from 'react'

/** 表单与对话输入共用的固定像素上限。 */
export const AUTO_GROW_FIXED_CAP_PX = 320

/** 对话输入在矮视口上额外按视口比例封顶，避免挤掉消息区。 */
export const AUTO_GROW_VIEWPORT_RATIO = 0.4

/**
 * 解析自适应高度上限。
 * 数字按像素；`viewport-cap` 取 `min(320px, 40vh)`，视口未知时回退到 320。
 *
 * @param {number|'viewport-cap'|undefined} maxHeight 固定上限或按视口封顶。
 * @param {number} [viewportHeight] 当前视口高度（px）。
 * @returns {number} 上限像素。
 */
export function resolveAutoGrowMaxHeight(maxHeight, viewportHeight = 0) {
  if (typeof maxHeight === 'number' && Number.isFinite(maxHeight) && maxHeight > 0) {
    return maxHeight
  }
  if (maxHeight === 'viewport-cap') {
    const vh = Number(viewportHeight)
    const viewportCap = Number.isFinite(vh) && vh > 0
      ? Math.round(vh * AUTO_GROW_VIEWPORT_RATIO)
      : AUTO_GROW_FIXED_CAP_PX
    return Math.min(AUTO_GROW_FIXED_CAP_PX, viewportCap)
  }
  return AUTO_GROW_FIXED_CAP_PX
}

/**
 * 把内容所需高度夹到上限；超过上限后由输入框内部滚动。
 *
 * @param {number} scrollHeight 内容所需高度。
 * @param {number} maxHeight 上限像素。
 * @returns {number} 应写入 style.height 的像素值。
 */
export function clampAutoGrowHeight(scrollHeight, maxHeight) {
  const height = Math.max(0, Number(scrollHeight) || 0)
  const cap = Number(maxHeight)
  if (!Number.isFinite(cap) || cap <= 0) return height
  return Math.min(height, cap)
}

/**
 * 折叠、隐藏或尚未挂载的输入框不能测量。
 * 折叠窄栏宽度很窄，按那时的换行量高度会算出错误的过高值。
 *
 * @param {Pick<HTMLElement, 'offsetParent'>|null} el 输入框。
 * @param {boolean} [enabled=true] 调用方是否允许测量。
 * @returns {boolean} 应跳过则为 true。
 */
export function shouldSkipAutoGrowMeasure(el, enabled = true) {
  if (!enabled || !el) return true
  if (el.offsetParent === null) return true
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
  }
  return false
}

/**
 * 按内容设置 textarea 高度，到上限后内部滚动；宽度变化时重测换行高度。
 *
 * @param {object} [options]
 * @param {string} [options.value] 当前文本，增减或发送清空后重测。
 * @param {boolean} [options.enabled=true] 为 false 时跳过测量（例如对话面板折叠）。
 * @param {number|'viewport-cap'} [options.maxHeight] 固定像素上限，或 `min(320px, 40vh)`。
 * @returns {import('react').MutableRefObject<HTMLTextAreaElement|null>}
 */
export function useAutoGrowTextarea({
  value = '',
  enabled = true,
  maxHeight = AUTO_GROW_FIXED_CAP_PX,
} = {}) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return undefined

    const apply = () => {
      if (shouldSkipAutoGrowMeasure(el, enabled)) return
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
      const cap = resolveAutoGrowMaxHeight(maxHeight, viewportHeight)
      el.style.maxHeight = `${cap}px`
      el.style.height = 'auto'
      el.style.height = `${clampAutoGrowHeight(el.scrollHeight, cap)}px`
    }

    apply()

    let lastWidth = el.clientWidth
    const observers = []
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (shouldSkipAutoGrowMeasure(el, enabled)) return
        const width = el.clientWidth
        if (width === lastWidth) return
        lastWidth = width
        apply()
      })
      observer.observe(el.parentElement || el)
      observers.push(observer)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', apply)
    }
    return () => {
      observers.forEach((observer) => observer.disconnect())
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', apply)
      }
    }
  }, [value, enabled, maxHeight])

  return ref
}
