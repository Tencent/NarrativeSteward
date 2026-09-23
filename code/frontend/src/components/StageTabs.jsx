import { useT } from '../i18n'

// 创作阶段标签条：点击切换中间构建面板。
// flags[id] = { dirty }：存在未保存草稿时在标签上显示提示圆点。
export default function StageTabs({ tabs, active, onChange, flags = {} }) {
  const t = useT()
  return (
    <div className="stage-tabs" role="tablist" data-quickstart="stage-tabs">
      {tabs.map((tab) => {
        const f = flags[tab.id] || {}
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            className={`stage-tab ${active === tab.id ? 'active' : ''}`}
            data-quickstart={tab.id === 'events' ? 'stage-events' : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {f.dirty && <span className="stage-tab-dot dot-dirty" title={t('workspace.tabs.unsaved')} />}
          </button>
        )
      })}
    </div>
  )
}
