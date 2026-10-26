/** Exploration is monotonic; active game history can still rewind independently. */
export function mergeExploration(previous, history, takenEdges, readLengths = {}, endedEventId = null) {
  const next = { events: { ...previous.events }, edges: [...previous.edges] }
  const edit = id => {
    if (!next.events[id]) next.events[id] = { id, rows: [], completed: false }
    else if (next.events[id] === previous.events[id]) next.events[id] = { ...next.events[id], rows: [...next.events[id].rows] }
    return next.events[id]
  }
  let active = null, beatId = ''
  history.forEach((row, index) => {
    if (row.kind === 'beat' && row.eventId) {
      if (active && active !== row.eventId) edit(active).completed = true
      active = row.eventId
      beatId = row.beat.id
      const event = edit(active)
      event.title = row.eventTitle
      if (!event.image && row.bgImage) event.image = row.bgImage
      if (!event.portrait && row.charImage) {
        event.portrait = row.charImage
        event.image = row.bgImage || ''
      }
      const content = row.beat.content.slice(0, readLengths[index] ?? 0)
      if (content) {
        const key = `beat:${beatId}`
        const existing = event.rows.findIndex(item => item.key === key)
        const entry = { key, kind: 'beat', speaker: row.beat.speakerDisplayName, content }
        if (existing < 0) event.rows.push(entry)
        else if (event.rows[existing].content.length < content.length) event.rows[existing] = entry
      }
    } else if (active && ['beat_choice', 'event_choice'].includes(row.kind)) {
      const event = edit(active)
      const key = `choice:${beatId}:${row.kind}:${row.label}`
      if (!event.rows.some(item => item.key === key)) event.rows.push({ key, kind: 'choice', content: row.label })
    }
  })
  if (endedEventId && next.events[endedEventId]) edit(endedEventId).completed = true
  for (const edge of takenEdges) if (edge.kind === 'event' && !next.edges.includes(edge.edge_id)) next.edges.push(edge.edge_id)
  return JSON.stringify(next) === JSON.stringify(previous) ? previous : next
}

/** Reveal topology, but never use source titles or artwork for locked events. */
export function storyProgress(events, exploration, currentId, takenEdges = [], routeEventIds = []) {
  const routeNodes = new Set(routeEventIds)
  const routeEdges = new Set(takenEdges.filter(edge => edge.kind === 'event').map(edge => edge.edge_id))
  return {
    nodes: events.nodes.map(event => {
      const known = exploration.events[event.id]
      return { id: event.id, title: known?.title || '???', locked: !known, current: event.id === currentId,
        onRoute: routeNodes.has(event.id), completed: Boolean(known?.completed), image: known?.image || '', portrait: known?.portrait || '', rows: known?.rows || [] }
    }),
    edges: events.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, explored: exploration.edges.includes(edge.id), onRoute: routeEdges.has(edge.id) })),
  }
}
