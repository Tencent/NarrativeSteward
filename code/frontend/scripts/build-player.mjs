/** Build a self-contained offline player using the same engine as the editor. */
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const frontend = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  configFile: false,
  root: frontend,
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, minify: true, cssCodeSplit: false,
    lib: { entry: path.join(frontend, 'src/player/main.jsx'), name: 'NarrativeStewardPlayer', formats: ['iife'] },
  },
})
const output = (Array.isArray(result) ? result[0] : result).output
const script = output.filter(item => item.type === 'chunk').map(item => item.code).join('\n')
const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => String(item.source)).join('\n')
const licenses = []
for (const name of ['react', 'react-dom', 'scheduler', '@xyflow/react', '@xyflow/system', 'dagre', 'graphlib', 'lodash', 'zustand', 'use-sync-external-store', 'classcat', 'd3-color', 'd3-dispatch', 'd3-drag', 'd3-ease', 'd3-interpolate', 'd3-selection', 'd3-timer', 'd3-transition', 'd3-zoom']) {
  licenses.push(`${name}\n${await readFile(path.join(frontend, 'node_modules', name, 'LICENSE'), 'utf8').catch(() => readFile(path.join(frontend, 'node_modules', name, 'LICENSE.md'), 'utf8'))}`)
}
const projectLicense = await readFile(path.join(frontend, '../backend/narrative_forge/resources/player-license.txt'), 'utf8')
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const html = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'self' file:; style-src 'unsafe-inline'; img-src 'self' file: blob: data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>NarrativeSteward Player</title><style>${css}</style></head><body><div id="root"></div><template id="license-text">${escape(projectLicense + '\n\n' + licenses.join('\n\n'))}</template><script src="./story.js"></script><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>\n`
const destination = path.join(frontend, '../backend/narrative_forge/resources/player.html')
await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, html)
console.log(`Offline player: ${Buffer.byteLength(html)} bytes`)
