import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'project-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE',
          source: readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8'),
        })
      },
    },
  ],
  build: {
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rolldownOptions: {
      output: { postBanner: '/*! Third-party licenses: see THIRD_PARTY_LICENSES.md. */' },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.NF_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
