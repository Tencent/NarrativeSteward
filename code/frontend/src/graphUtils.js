/**
 * 返回前向图唯一的零入度入口；非法图退化为首节点。
 *
 * 试玩与编辑画布共享同一入口定义，避免两处对“故事从哪里开始”的判断漂移。
 *
 * @param {Array<string>} nodeIds 图中稳定节点 id。
 * @param {Array<{source?:string,target?:string}>} edges 图边。
 * @returns {string|undefined} 入口节点 id；空图返回 undefined。
 */
export function findEntryNodeId(nodeIds, edges) {
  const indegree = Object.fromEntries(nodeIds.map((id) => [id, 0]))
  for (const edge of edges || []) {
    if (edge.target in indegree) indegree[edge.target] += 1
  }
  return nodeIds.find((id) => indegree[id] === 0) ?? nodeIds[0]
}

/**
 * 关系图结构指纹：只含节点/边稳定 id，不含标题、正文或情节状态。
 *
 * @param {Array<{id?: string}>} nodes 节点或节拍。
 * @param {Array<{id?: string, source?: string, target?: string}>} edges 边。
 * @returns {string}
 */
export function graphTopologyKey(nodes, edges) {
  const nodeIds = (nodes || []).map((node) => node.id).filter(Boolean).slice().sort().join(',')
  const edgeIds = (edges || [])
    .map((edge) => edge.id || `${edge.source || ''}->${edge.target || ''}`)
    .filter(Boolean)
    .slice()
    .sort()
    .join(',')
  return `${nodeIds}|${edgeIds}`
}

/**
 * 事件图结构指纹：只含节点/边稳定 id，不含标题或情节状态。
 * 结构不变时预览刷新应保留视口；id 集合变化时需要重新铺满，否则新节点会落在视野外。
 *
 * @param {Array<{id?: string}>} nodes 事件节点。
 * @param {Array<{id?: string, source?: string, target?: string}>} edges 事件边。
 * @returns {string}
 */
export function eventGraphTopologyKey(nodes, edges) {
  return graphTopologyKey(nodes, edges)
}

/**
 * 结构变化时需要重新适配画布；仅标题或情节状态变化时保持当前视口。
 *
 * @param {string} previousKey 上一份结构指纹。
 * @param {string} nextKey 当前结构指纹。
 * @returns {boolean}
 */
export function shouldRefitEventGraph(previousKey, nextKey) {
  if (!nextKey || nextKey === '|') return false
  if (!previousKey || previousKey === '|') return true
  return previousKey !== nextKey
}

/**
 * 决定拓扑变化后要不要安排一次铺满。
 *
 * 结构指纹只记录已经完成适配的拓扑：同一拓扑若已有待执行任务，不得取消；新拓扑才取消旧任务。
 *
 * @param {object} options
 * @param {string} options.topologyKey 当前节点/边稳定 id 指纹。
 * @param {string} [options.fittedKey] 上次已经完成适配的指纹。
 * @param {string|null} [options.pendingKey] 正在等待执行的指纹。
 * @param {boolean} [options.firstAppearance] 是否交给首次视口初始化，而不是这次补调。
 * @returns {'skip-empty'|'already-fitted'|'keep-pending'|'defer-initial'|'schedule'}
 */
export function eventGraphFitAction({
  topologyKey,
  fittedKey = '',
  pendingKey = null,
  firstAppearance = false,
} = {}) {
  if (!topologyKey || topologyKey === '|') return 'skip-empty'
  if (fittedKey === topologyKey) return 'already-fitted'
  if (pendingKey === topologyKey) return 'keep-pending'
  if (firstAppearance) return 'defer-initial'
  return 'schedule'
}
