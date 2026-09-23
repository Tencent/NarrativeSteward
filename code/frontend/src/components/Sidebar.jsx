import { useState } from 'react'
import { useT } from '../i18n'
import { FORMAL_PRODUCT_NAME } from '../branding'

/**
 * 左侧项目面板，提供项目新建、切换以及不丢失内部状态的窄栏折叠。
 * 素材管理位于中间 MaterialsPanel，不属于本组件。
 * @param {object} props 组件参数。
 * @param {Array<object>} props.projects 可选择的项目摘要。
 * @param {string|null} props.selectedId 当前项目 id。
 * @param {boolean} props.collapsed 是否显示为窄栏。
 * @param {boolean} [props.disabled] 配图等项目级操作进行中时禁止切换或新建。
 * @param {(id: string) => void} props.onSelect 项目选择回调。
 * @param {(name: string) => void} props.onCreate 项目创建回调。
 * @param {() => void} props.onToggle 展开或收起面板的回调。
 */
export default function Sidebar({ projects, selectedId, collapsed, disabled = false, onSelect, onCreate, onToggle }) {
  const t = useT()
  const [name, setName] = useState('')

  // 提交经过清理的项目名；空名称不触发请求，创建后清空输入草稿。
  const create = () => {
    if (disabled) return
    const n = name.trim()
    if (!n) return
    onCreate(n)
    setName('')
  }

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} data-quickstart="sidebar">
      <div className="sidebar-head">
        <div className="brand">{FORMAL_PRODUCT_NAME}</div>
        <button
          type="button"
          className="panel-toggle"
          aria-label={collapsed ? t('workspace.sidebar.expand') : t('workspace.sidebar.collapse')}
          aria-expanded={!collapsed}
          title={collapsed ? t('workspace.sidebar.expand') : t('workspace.sidebar.collapse')}
          onClick={onToggle}
        >
          <span aria-hidden>{collapsed ? '›' : '‹'}</span>
        </button>
      </div>

      <div className="sidebar-content" aria-hidden={collapsed}>
        <div className="new-project" data-quickstart="create-project">
          <input
            className="field-input"
            type="text"
            value={name}
            placeholder={t('workspace.sidebar.newName')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !disabled && create()}
          />
          <button className="btn btn-primary btn-small" onClick={create} disabled={disabled || !name.trim()}>
            {t('workspace.sidebar.create')}
          </button>
        </div>

        <div className="project-list">
          {projects.length === 0 && <div className="muted pad">{t('workspace.sidebar.empty')}</div>}
          {projects.map((p) => (
            <button
              key={p.id}
              className={`project-item ${p.id === selectedId ? 'active' : ''}`}
              disabled={disabled && p.id !== selectedId}
              onClick={() => onSelect(p.id)}
            >
              <span className="project-name">{p.name}</span>
              <span className="project-id">{p.id}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
