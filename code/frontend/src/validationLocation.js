/**
 * 把正式检测 issue 或复杂度位置转换为编辑器定位目标。
 *
 * @param {Record<string, any>} item 正式问题或复杂度 top position。
 * @returns {{
 *   panel: 'events'|'scene'|null,
 *   eventId: string|null,
 *   focusKind: 'node'|'edge'|'beat'|null,
 *   focusId: string|null
 * }} 编辑器面板和高亮目标。
 */
export function validationLocation(item = {}) {
  const isSceneEdge = item.kind === 'scene_edge_never_enabled'
    || item.target_kind === 'scene_edge'
  const positionKind = item.position_kind || String(item.position || '').split(':')[0]
  const isSceneItem = Boolean(item.beat_id)
    || isSceneEdge
    || item.kind === 'beat_unreachable'
    || item.kind === 'scene_missing'
    || positionKind === 'BT'

  if (isSceneItem && item.event_id) {
    return {
      panel: 'scene',
      eventId: item.event_id,
      focusKind: isSceneEdge ? 'edge' : item.beat_id ? 'beat' : null,
      focusId: isSceneEdge ? item.edge_id || null : item.beat_id || null,
    }
  }

  const isEventEdge = item.kind === 'event_edge_never_enabled'
    || item.target_kind === 'event_edge'
  const focusId = isEventEdge ? item.edge_id : item.event_id
  if (focusId) {
    return {
      panel: 'events',
      eventId: item.event_id || null,
      focusKind: isEventEdge ? 'edge' : 'node',
      focusId,
    }
  }

  return {
    panel: null,
    eventId: null,
    focusKind: null,
    focusId: null,
  }
}
