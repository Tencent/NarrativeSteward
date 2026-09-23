import { useEffect, useState } from 'react'

/**
 * 表单草稿状态：以服务端内容为基线，按 revision 变化重新播种（保存成功 / 被 Agent 更新后）。
 * @param {any} content 服务端当前内容
 * @param {number} revision 服务端当前版本（变化即重置草稿）
 * @returns {[any, Function, boolean, Function]} [draft, setDraft, dirty, reset]
 */
export function useDraft(content, revision) {
  // 基线同时包含版本和内容：不同项目可能恰好使用相同 revision，不能只靠版本区分。
  const baseline = JSON.stringify([revision ?? null, content])
  const [state, setState] = useState(() => ({ draft: content, baseline }))
  const synchronized = state.baseline === baseline

  // 服务端基线刚变化、effect 尚未执行时直接使用新内容，避免旧项目草稿被短暂判为 dirty。
  const draft = synchronized ? state.draft : content

  // 保存成功、Agent 改写或项目切换后，用最新服务端内容正式重置内部草稿。
  useEffect(() => {
    setState((previous) => (
      previous.baseline === baseline ? previous : { draft: content, baseline }
    ))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline])

  /**
   * 更新当前基线下的本地草稿；支持与 React setState 相同的值或函数形式。
   *
   * @param {any|Function} nextDraft 新草稿，或接收当前草稿的更新函数。
   */
  const setDraft = (nextDraft) => {
    setState((previous) => {
      const current = previous.baseline === baseline ? previous.draft : content
      const next = typeof nextDraft === 'function' ? nextDraft(current) : nextDraft
      return { draft: next, baseline }
    })
  }

  // 基线切换中的中间渲染永远不是用户编辑，只有同步后的差异才算未保存。
  const dirty = synchronized && JSON.stringify(draft) !== JSON.stringify(content)
  const reset = () => setState({ draft: content, baseline })
  return [draft, setDraft, dirty, reset]
}
