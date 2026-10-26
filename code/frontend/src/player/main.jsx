import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider, useLocale } from '../i18n/LocaleContext.jsx'
import { usePlaytest } from '../hooks/usePlaytest.js'
import { loadBundledProject } from './packageLoader.js'
import { mergeExploration } from './progress.js'
import { ProgressDialog } from './ProgressDialog.jsx'
import { TextPages, ChoicePages } from './ui.jsx'
import './player.css'

function Story({ project }) {
  const { locale, setLocale } = useLocale()
  const en = locale === 'en-US'
  const pt = usePlaytest('offline', project.dataSource)
  const stageRef = useRef(null)
  const [instantText, setInstantText] = useState(() => {
    try { return localStorage.getItem('gflow.player.instantText') === 'true' } catch { return false }
  })
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  function toggleText() {
    setInstantText(value => {
      try { localStorage.setItem('gflow.player.instantText', String(!value)) } catch { /* Offline storage may be disabled. */ }
      return !value
    })
  }
  useEffect(() => {
    function onKeyDown(event) {
      const stage = stageRef.current
      if (!stage || event.defaultPrevented || event.isComposing ||
          event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
          document.querySelector('dialog[open]') ||
          event.target instanceof Element && (event.target.isContentEditable ||
            event.target.closest('input, textarea, select, [role="textbox"], .condition-info'))) return
      const space = event.code === 'Space'
      const digit = /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : null
      if (!space && !digit) return
      // Prevent native Space from activating a focused branch/restart button.
      event.preventDefault()
      if (event.repeat) return
      const reveal = stage.querySelector('[data-reveal-text]')
      if (reveal) { if (space) reveal.click(); return }
      const nextPage = stage.querySelector('[data-next-page]:not(:disabled)')
      const button = space ? (nextPage || stage.querySelector('[data-shortcut="Space"]'))
        : stage.querySelector(`[data-shortcut="${digit}"]`)
      // Reuse the click action, including disabled and full-option reading gates.
      if (button && !button.disabled) button.click()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(null)
  const [readLengths, setReadLengths] = useState({})
  const [exploration, setExploration] = useState({ events: {}, edges: [] })
  useEffect(() => {
    setExploration(previous => mergeExploration(previous, pt.history, pt.takenEdges, readLengths, pt.status === 'ending' ? pt.current?.event_id : null))
  }, [pt.history, pt.takenEdges, pt.current, pt.status, readLengths])
  const [lastPage, setLastPage] = useState(false)
  const [readingEpoch, setReadingEpoch] = useState(0)
  const index = pt.history.findLastIndex(row => row.kind === 'beat')
  const item = pt.history[index]
  const beat = item?.beat
  const locked = pt.isAdvancing || pt.status === 'loading'
  const recordRead = useCallback(length => setReadLengths(previous => previous[index] >= length ? previous : { ...previous, [index]: length }), [index])
  async function act(fn) {
    setError('')
    try { await fn() } catch (err) { setError(err.message) }
  }
  function start() { setReadingEpoch(epoch => epoch + 1); setReadLengths({}); setLastPage(false); act(pt.start) }
  function undo() {
    setReadingEpoch(epoch => epoch + 1)
    setLastPage(false)
    setReadLengths(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => Number(key) < index)))
    pt.undo()
  }
  function rewind(eventId) {
    const restored = pt.rewindToEvent(eventId)
    if (!restored) return
    setReadLengths(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => Number(key) < restored.historyLength - 1)))
    setLastPage(false)
    setReadingEpoch(epoch => epoch + 1)
    setDialog(null)
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch { setError(en ? 'Fullscreen is unavailable in this browser.' : '当前浏览器不支持全屏。') }
  }
  const idle = pt.status === 'idle'
  return <div className="player">
    <header className="toolbar">
      <span className="story-title" title={project.title}>{idle ? 'NarrativeSteward' : project.title}</span>
      <nav aria-label={en ? 'Game controls' : '游戏控制'}>
        {!idle && <>
          <button onClick={undo} disabled={!pt.canUndo || locked}>{en ? 'Back' : '回退一步'}</button>
          <button onClick={start} disabled={locked}>{en ? 'Restart' : '重新开始'}</button>
          <button onClick={() => setDialog('progress')} disabled={locked}>{en ? 'Story progress' : '故事进度'}</button>
        </>}
        <button aria-pressed={instantText} onClick={toggleText} title={en ? 'Toggle instant text' : '切换文字显示方式'}>{en ? (instantText ? 'Text: instant' : 'Text: gradual') : (instantText ? '文字：即时' : '文字：逐字')}</button>
        <button onClick={() => setLocale(en ? 'zh-CN' : 'en-US')}>{en ? '中文' : 'EN'}</button>
        <button onClick={fullscreen}>{en ? 'Fullscreen' : '全屏'}</button>
      </nav>
    </header>
    {idle ? <section className="welcome">
      <div className="eyebrow">NARRATIVESTEWARD</div>
      <h1>{project.title}</h1><p>{en ? 'Your choices shape the story.' : '故事将随你的选择展开。'}</p>
      <button className="primary" onClick={start}>{en ? 'Start story' : '开始游戏'}</button>
    </section> : <main ref={stageRef} className="stage" data-event={item?.eventId} data-beat={beat?.id} onClick={event => {
      if (!event.target.closest('button, a, .condition-info')) stageRef.current?.querySelector('[data-reveal-text]')?.click()
    }} style={item?.bgImage ? { backgroundImage: `url("${item.bgImage}")` } : {}}>
      {item?.locationName && <div className="location">{item.locationName}</div>}
      {item?.charImage && <img className={`portrait${item.portraitDisplay === 'object' ? ' portrait-object' : ''}`} src={item.charImage} alt={beat?.speakerDisplayName || ''} />}
      <div className={`dialogue${pt.choices.length <= 1 ? ' compact' : ''}`}>
        {pt.status === 'ending' ? <section className="ending">
          <div className="speaker"><h2 title={pt.ending?.title}>{pt.ending?.title || (en ? 'The end' : '故事结局')}</h2></div>
          <TextPages key="ending" text={pt.ending?.summary || ''} en={en} />
          <div className="choice-slot"><button className="primary" onClick={start}>{en ? 'Play again' : '再次游玩'}</button></div>
        </section> : <>
          <div className="speaker">{['dialogue', 'monologue'].includes(beat?.kind) ? beat.speakerDisplayName : ''}</div>
          <TextPages key={`${readingEpoch}:${index}:${beat?.id}`} text={beat?.content || ''} en={en} animate instant={instantText || reducedMotion} paused={!!dialog} onRead={recordRead} onLastPage={setLastPage} />
          <div className="reader-notice">{pt.status === 'loading' && <p role="status">{en ? 'Loading…' : '正在加载…'}</p>}
          {pt.errorMsg && <p role="alert">{pt.errorMsg}</p>}
          {pt.status === 'blocked' && <p role="alert">{en ? 'This scene is incomplete.' : '这段情节尚未完成。'} {pt.blockedEvent?.title}</p>}
          {pt.status === 'dead_end' && <p role="alert">{en ? 'No available route. Go back to choose again.' : '当前没有可走的路线，可以回退重新选择。'}</p>}</div>
          <div className="choice-slot">{lastPage ? <ChoicePages key={`${readingEpoch}:${index}:${beat?.id}`} choices={pt.choices} locked={locked} en={en} onChoose={id => act(() => pt.choose(id))} />
            : <p className="reading-hint">{en ? 'Read on to continue the story.' : '读完本段，继续故事。'}</p>}</div>
        </>}
      </div>
    </main>}
    {error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
    {dialog === 'progress' && <ProgressDialog pt={pt} project={project} exploration={exploration} en={en} onRewind={rewind} onClose={() => setDialog(null)} />}
  </div>
}

function Player() {
  const { locale } = useLocale()
  const en = locale === 'en-US'
  const [project, setProject] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false, loaded = null
    loadBundledProject(window.NARRATIVE_STEWARD_STORY).then(value => {
      loaded = value
      if (disposed) value.dispose()
      else { document.title = value.title; setProject(value) }
    }).catch(err => { if (!disposed) setError(err.message) })
    return () => { disposed = true; loaded?.dispose() }
  }, [])
  if (project) return <Story project={project} />
  return <div className="player"><section className="welcome"><div className="eyebrow">NARRATIVESTEWARD</div>
    {error ? <><h1>{en ? 'Unable to open story' : '无法打开故事'}</h1><p role="alert">{error}</p><p>{en ? 'Extract the whole package and keep player.html, story.js and project together.' : '请完整解压，保持 player.html、story.js 与 project 文件夹在一起。'}</p></> : <p role="status">{en ? 'Opening story…' : '正在打开故事…'}</p>}
  </section></div>
}

createRoot(document.getElementById('root')).render(<LocaleProvider><Player /></LocaleProvider>)
