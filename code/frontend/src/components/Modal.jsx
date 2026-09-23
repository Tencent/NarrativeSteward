import { useEffect } from 'react'
import { useT } from '../i18n'

/**
 * 通用居中弹出卡片（遮罩 + 居中面板）。用于"点开一项、居中专注查看/操作"的场景，
 * 与右侧 `Drawer` 并存、按场景择一。
 *
 * 交互：点击遮罩或右上角 × 关闭；按 Esc 关闭。内容与业务状态由调用方持有
 * （本组件只管展示/关闭）。尺寸经 `size` 粗调（`sm`/`md`/`lg`），大图内容用 `lg`。
 *
 * @param {boolean} open 是否打开（false 时不渲染）
 * @param {string} title 弹窗标题
 * @param {()=>void} onClose 关闭回调
 * @param {React.ReactNode} children 主体内容
 * @param {React.ReactNode} [footer] 底部操作区
 * @param {'sm'|'md'|'lg'} [size] 尺寸档位（默认 md）
 */
export default function Modal({ open, title, onClose, children, footer, size = 'md' }) {
  const t = useT()
  // Esc 关闭：仅在打开时挂监听。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* 阻止冒泡，点击面板内部不触发遮罩关闭 */}
      <div
        className={`modal-panel modal-${size}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
