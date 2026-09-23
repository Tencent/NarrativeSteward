import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { LocaleProvider } from './i18n'
import './styles.css'

// 不用 StrictMode：其在 dev 下会双调用 effect，导致 SSE 连接开/关/再开，调试期更吵。
ReactDOM.createRoot(document.getElementById('root')).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
)
