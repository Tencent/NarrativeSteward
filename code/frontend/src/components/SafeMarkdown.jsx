import ReactMarkdown from 'react-markdown'

/**
 * 安全渲染 Markdown：不启用原始 HTML，外链在新标签打开。
 *
 * 用于 Agent 完整回复、任务说明等创作者可见富文本。生成中的不完整文本不要走这里。
 *
 * @param {object} props 组件参数。
 * @param {string} [props.children] Markdown 原文。
 * @param {string} [props.className] 附加样式类。
 * @returns {JSX.Element} 渲染后的文档片段。
 */
export default function SafeMarkdown({ children, className = '' }) {
  return (
    <div className={['markdown-body', className].filter(Boolean).join(' ')}>
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          ),
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  )
}
