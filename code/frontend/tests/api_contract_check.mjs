/**
 * 前端 API 契约：调用方引用的方法必须存在，且关键路径的 HTTP 方法/URL/body 正确。
 *
 * 运行：node tests/api_contract_check.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(root, '../src')

function walkJs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkJs(full, acc)
    else if (name.endsWith('.js') || name.endsWith('.jsx')) acc.push(full)
  }
  return acc
}

const apiSource = readFileSync(join(srcRoot, 'api.js'), 'utf8')
const exportedMethods = new Set()
for (const match of apiSource.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)) {
  exportedMethods.add(match[1])
}
assert.equal(exportedMethods.has('chat'), true, 'api.chat 必须存在，否则发送根本不会发出 POST')

const missing = []
const callRe = /\bapi\.([A-Za-z][A-Za-z0-9]*)\s*\(/g
for (const file of walkJs(srcRoot)) {
  if (file.endsWith('/api.js') || file.endsWith('\\api.js')) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(callRe)) {
    const method = match[1]
    if (!exportedMethods.has(method)) {
      missing.push(`${file.slice(srcRoot.length + 1)}: api.${method}`)
    }
  }
}
assert.equal(missing.length, 0, `调用了不存在的 api 方法:\n${missing.join('\n')}`)

const fetchCalls = []
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({
    url: String(url),
    method: opts.method || 'GET',
    body: opts.body,
    headers: opts.headers || {},
  })
  const path = String(url)
  if (path.includes('/chat/preview/')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ preview_generation: 1, fragments: {} }),
      text: async () => '',
    }
  }
  if (path.endsWith('/chat/run')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'idle', turn_id: null }),
      text: async () => '',
    }
  }
  if (path.endsWith('/chat/stop')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'stop_requested', turn_id: 't-1' }),
      text: async () => '',
    }
  }
  if (path.endsWith('/chat') && (opts.method || 'GET') === 'POST') {
    return {
      ok: true,
      status: 202,
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'started', turn_id: 't-1' }),
      text: async () => '',
    }
  }
  return {
    ok: false,
    status: 409,
    statusText: 'Conflict',
    headers: { get: () => 'application/json' },
    json: async () => ({ detail: '冲突' }),
    text: async () => '{"detail":"冲突"}',
  }
}

const { api } = await import('../src/api.js')
assert.equal(typeof api.chat, 'function')
assert.equal(typeof api.chatRun, 'function')
assert.equal(typeof api.stopChat, 'function')
assert.equal(typeof api.getTurnPreview, 'function')

const chatPayload = await api.chat('p1', '你好')
const chatCall = fetchCalls.at(-1)
assert.equal(chatCall.method, 'POST')
assert.equal(chatCall.url, '/api/projects/p1/chat')
assert.equal(chatCall.body, JSON.stringify({ message: '你好', locale: 'zh-CN' }))
const enChat = await api.chat('p1', 'hello', 'en-US')
assert.equal(fetchCalls.at(-1).body, JSON.stringify({ message: 'hello', locale: 'en-US' }))
await api.chat('p1', '改这里', 'zh-CN', { schema_version: 1, status: 'playing' })
assert.equal(
  fetchCalls.at(-1).body,
  JSON.stringify({
    message: '改这里',
    locale: 'zh-CN',
    playtest_context: { schema_version: 1, status: 'playing' },
  }),
)
assert.equal(enChat.status, 'started')
assert.equal(chatPayload.turn_id, 't-1')
assert.equal(chatPayload.status, 'started')

await api.chatRun('p1')
const runCall = fetchCalls.at(-1)
assert.equal(runCall.method, 'GET')
assert.equal(runCall.url, '/api/projects/p1/chat/run')

await api.stopChat('p1')
const stopCall = fetchCalls.at(-1)
assert.equal(stopCall.method, 'POST')
assert.equal(stopCall.url, '/api/projects/p1/chat/stop')

await api.getTurnPreview('p1', 't-1', 2)
const previewCall = fetchCalls.at(-1)
assert.equal(previewCall.method, 'GET')
assert.equal(previewCall.url, '/api/projects/p1/chat/preview/t-1/2')

let thrown = null
try {
  await api.getData('missing', 'intent')
} catch (err) {
  thrown = err
}
assert.equal(thrown?.status, 409, '非 2xx 必须把 HTTP status 挂到 Error 上')

console.log('api_contract_check: all assertions passed')
