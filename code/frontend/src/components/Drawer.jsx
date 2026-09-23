import { useEffect } from 'react'
import { useT } from '../i18n'

/**
 * 通用右侧滑出抽屉（右侧覆盖层 + 遮罩）。用于卡片详情编辑等"点开一项、专注编辑"的场景。
 *
 * 交互：点击遮罩或右上角 × 关闭；按 Esc 关闭。内容与底层数据的联动由调用方负责
 * （抽屉只管展示/关闭，不持有业务状态）。
 *
 * @param {boolean} open 是否打开（false 时不渲染）
 * @param {string} title 抽屉标题
 * @param {()=>void} onClose 关闭回调
 * @param {React.ReactNode} children 抽屉主体内容
 * @param {React.ReactNode} [footer] 底部操作区（如"删除"）
 */
export default function Drawer({ open, title, onClose, children, footer }) {
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
    <div className="drawer-overlay" onClick={onClose}>
      {/* 阻止冒泡，点击面板内部不触发遮罩关闭 */}
      <div
        className="drawer-panel"
        data-quickstart="world-card-editor"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="drawer-head">
          <span className="drawer-title">{title}</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  )
}
