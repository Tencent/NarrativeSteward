import { useEffect, useRef } from 'react'
import { api } from '../api'

// 后端 SSE 推送的事件类型（见 backend DESIGN §6.9 / routes.py）。
const EVENT_TYPES = [
  'ready',
  'text',
  'agent_text',
  'tool_start',
  'tool_end',
  'budget_status',
  'data_preview_published',
  'preview_revoked',
  'status',
  'data_updated',
  'agent_changeset_updated',
  'validation_updated',
  'validation_run_updated',
  'turn_start',
  'turn_stop_requested',
  'turn_stopped',
  'turn_completed',
  'turn_end',
  'error',
]

/**
 * 订阅某项目的 SSE 事件流；handlers 为 {事件类型: (payload)=>void} 映射。
 * handlers 用 ref 持有，保证回调始终看到最新闭包，且不会因 handlers 变化而重连。
 * @param {string|null} projectId
 * @param {Record<string, (payload:object)=>void>} handlers
 */
export function useProjectEvents(projectId, handlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!projectId) return undefined
    const es = new EventSource(api.eventsUrl(projectId))
    const registered = {}
    for (const type of EVENT_TYPES) {
      const fn = (e) => {
        // EventSource 的连接级错误也走 'error' 且无 data，需跳过。
        if (type === 'error' && !e.data) return
        let payload = {}
        try {
          payload = e.data ? JSON.parse(e.data) : {}
        } catch {
          payload = {}
        }
        handlersRef.current[type]?.(payload)
      }
      es.addEventListener(type, fn)
      registered[type] = fn
    }
    return () => {
      for (const type of EVENT_TYPES) es.removeEventListener(type, registered[type])
      es.close()
    }
  }, [projectId])
}
