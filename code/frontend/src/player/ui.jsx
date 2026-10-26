import { createPortal } from 'react-dom'
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export function Modal({ title, onClose, en, className = '', children }) {
  const ref = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    ref.current.showModal()
    return () => { opener?.focus() }
  }, [])
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === ref.current) onClose() }}>
    <div className="modal-inner">
      <div className="modal-heading"><h2>{title}</h2><button autoFocus aria-label={en ? 'Close' : '关闭'} onClick={onClose}>×</button></div>
      {children}
    </div>
  </dialog>
}

/** Measure actual wrapping; text pages never depend on a fixed character count. */
export function TextPages({ text = '', en, onRead, onLastPage, animate = false, instant = false, paused = false }) {
  const ref = useRef(null)
  const anchor = useRef(0)
  const [pages, setPages] = useState([''])
  const [page, setPage] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    function paginate() {
      const budget = parseFloat(getComputedStyle(element).maxHeight) || element.clientHeight
      if (!element.clientWidth || !budget) return
      const measure = element.cloneNode(false)
      measure.removeAttribute('id')
      Object.assign(measure.style, { position: 'fixed', visibility: 'hidden', width: `${element.clientWidth}px`, height: 'auto', maxHeight: 'none', inset: '0 auto auto -10000px' })
      element.parentElement.appendChild(measure)
      const chars = Array.from(text)
      const result = []
      let offset = 0
      while (offset < chars.length) {
        let lo = 1, hi = chars.length - offset, count = 1
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2)
          measure.textContent = chars.slice(offset, offset + mid).join('')
          if (measure.scrollHeight <= budget + 1) { count = mid; lo = mid + 1 } else hi = mid - 1
        }
        // Prefer a sentence or word boundary when it is near the end of the page.
        const candidate = chars.slice(offset, offset + count).join('')
        const boundary = [...candidate.matchAll(/[。！？；\n\s]/gu)].at(-1)
        if (offset + count < chars.length && boundary && boundary.index > candidate.length * .7) count = Array.from(candidate.slice(0, boundary.index + 1)).length
        result.push(chars.slice(offset, offset + count).join(''))
        offset += count
      }
      measure.remove()
      let offsetAtPage = 0, nextPage = 0
      for (let index = 0; index < result.length; index++) {
        if (offsetAtPage <= anchor.current) nextPage = index
        offsetAtPage += result[index].length
      }
      setPages(result.length ? result : [''])
      setPage(nextPage)
    }
    const observer = new ResizeObserver(paginate)
    observer.observe(element)
    paginate()
    return () => observer.disconnect()
  }, [text])
  const pageText = pages[page] || ''
  const characters = Array.from(pageText)
  const [visible, setVisible] = useState(0)
  const ready = pages.join('') === text
  const typing = animate && !instant && visible < characters.length
  useLayoutEffect(() => { setVisible(animate && !instant ? 0 : Array.from(pageText).length) }, [pageText, animate, instant])
  useEffect(() => {
    if (!typing || paused) return
    const timer = window.setInterval(() => setVisible(value => Math.min(value + 1, characters.length)), 36)
    return () => window.clearInterval(timer)
  }, [typing, paused, pageText, characters.length])
  useLayoutEffect(() => {
    anchor.current = pages.slice(0, page).join('').length
    const shown = typing ? characters.slice(0, visible).join('').length : pageText.length
    if (ready) onRead?.(anchor.current + shown)
    onLastPage?.(ready && !typing && page === pages.length - 1)
  }, [page, pages, onRead, onLastPage, typing, visible, ready, pageText])
  const reveal = () => setVisible(characters.length)
  return <>
    <p className={`content${animate ? ' progressive-content' : ''}`} ref={ref}
      data-typing={typing ? 'true' : 'false'} onClick={typing ? reveal : undefined}>
      {animate ? <><span className="text-measure" aria-hidden="true">{pageText}</span><span className="text-shown">{typing ? characters.slice(0, visible).join('') : pageText}</span></> : pageText}
    </p>
    <div className="text-pagination">
      {typing && <button data-reveal-text onClick={reveal}>{en ? 'Show all · Space' : '显示全文 · 空格'}</button>}
      {pages.length > 1 && <><button disabled={page === 0} onClick={() => setPage(page - 1)}>{en ? 'Previous page' : '上一页'}</button><span>{page + 1} / {pages.length}</span>{page < pages.length - 1 && <button data-next-page aria-keyshortcuts="Space" disabled={typing} onClick={() => setPage(page + 1)}>{en ? 'Next page' : '下一页'}</button>}</>}
    </div>
  </>
}

/** The information control remains operable beside an unavailable choice. */
function ConditionInfo({ choice, en }) {
  const ref = useRef(null)
  const tooltipRef = useRef(null)
  const id = useId()
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const reason = choice.disabledReason || (en ? 'Conditions not met' : '不满足选择条件')
  useLayoutEffect(() => {
    if (!hover || open) return
    const place = () => {
      const anchor = ref.current.getBoundingClientRect()
      const box = tooltipRef.current.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)),
        top: Math.max(8, anchor.top >= box.height + 16 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)) })
    }
    const escape = event => { if (event.key === 'Escape') setHover(false) }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('keydown', escape) }
  }, [hover, open, reason])
  return <span className="condition-info" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button ref={ref} type="button" className="condition-info-button"
      aria-label={`${en ? 'View choice conditions' : '查看选择条件'}：${choice.label}`}
      aria-describedby={hover && !open ? id : undefined} aria-haspopup="dialog"
      onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      onClick={() => { setHover(false); setOpen(true) }}><span className="info-symbol" aria-hidden="true">i</span></button>
    {hover && !open && createPortal(<div ref={tooltipRef} id={id} role="tooltip" className="condition-tooltip" style={position}>{reason}</div>, document.body)}
    {open && <Modal title={en ? 'Choice conditions' : '选择条件'} en={en} className="condition-dialog" onClose={() => { setHover(false); setOpen(false) }}>
      <div className="condition-detail"><p>{choice.label}</p><p className="condition-reason">{reason}</p></div>
    </Modal>}
  </span>
}

/** Full labels remain available without changing the fixed action row. */
function ChoiceOption({ choice, index, single, locked, selected, en, onSelect, onDetail }) {
  const labelRef = useRef(null)
  const rowRef = useRef(null)
  const tipRef = useRef(null)
  const leaveTimer = useRef(null)
  const id = useId()
  const [truncated, setTruncated] = useState(false)
  const [hover, setHover] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const caption = single && !choice.disabled ? (en ? 'Continue →' : '下一步 →') : choice.label
  const suffix = choice.disabled ? (en ? ' · Conditions not met' : ' · 不满足选择条件') : ''
  useLayoutEffect(() => {
    const label = labelRef.current
    const measure = () => setTruncated(label.scrollWidth > label.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(label); measure()
    return () => observer.disconnect()
  }, [caption, suffix])
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])
  useLayoutEffect(() => {
    if (!hover || !truncated) return
    const place = () => {
      const anchor = rowRef.current.getBoundingClientRect(), tip = tipRef.current.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - tip.width - 8)),
        top: Math.max(8, anchor.top - tip.height - 8) })
    }
    const dismiss = event => { if (event.key === 'Escape') setHover(false) }
    place(); window.addEventListener('resize', place); window.addEventListener('keydown', dismiss)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('keydown', dismiss) }
  }, [hover, truncated, caption])
  const enter = () => { window.clearTimeout(leaveTimer.current); setHover(true) }
  const leave = () => { leaveTimer.current = window.setTimeout(() => setHover(false), 140) }
  const shortcut = single ? 'Space' : String(index + 1)
  return <div ref={rowRef} className={`choice-row${choice.disabled ? ' has-condition' : ''}`} onMouseEnter={enter} onMouseLeave={leave}>
    <button className={`choice-button has-shortcut${selected === choice.id ? ' is-selected' : ''}`}
      data-shortcut={shortcut} aria-keyshortcuts={shortcut} data-truncated={truncated ? 'true' : 'false'}
      aria-label={caption + suffix} aria-describedby={hover && truncated ? id : undefined}
      aria-haspopup={truncated && !choice.disabled ? 'dialog' : undefined}
      disabled={locked || selected !== null || choice.disabled}
      onFocus={enter} onBlur={() => setHover(false)}
      onClick={() => {
        window.clearTimeout(leaveTimer.current); setHover(false)
        if (labelRef.current.scrollWidth > labelRef.current.clientWidth + 1 && !single) onDetail(choice)
        else onSelect(choice.id)
      }}>
      <span className="shortcut-key" aria-hidden="true" data-key={single ? (en ? 'Space' : '空格') : index + 1} />
      <span ref={labelRef} className="choice-label">{caption}{choice.disabled && <span className="locked">{suffix}</span>}</span>
    </button>
    {choice.disabled && <ConditionInfo choice={choice} en={en} />}
    {hover && truncated && createPortal(<div ref={tipRef} id={id} role="tooltip" className="choice-tooltip" style={position}
      onMouseEnter={enter} onMouseLeave={leave}>{choice.label}{suffix}</div>, document.body)}
  </div>
}

export function ChoicePages({ choices, locked, en, onChoose }) {
  const ref = useRef(null)
  const [groups, setGroups] = useState([choices.slice(0, 3)])
  const [detail, setDetail] = useState(null)
  const [detailRead, setDetailRead] = useState(false)
  const [selected, setSelected] = useState(null)
  const selection = useRef(null)
  const selectionTimer = useRef(null)
  useEffect(() => () => window.clearTimeout(selectionTimer.current), [])
  useLayoutEffect(() => {
    window.clearTimeout(selectionTimer.current)
    selection.current = null
    setSelected(null)
  }, [choices])
  function select(id) {
    if (locked || selection.current !== null) return
    selection.current = id
    setSelected(id)
    const delay = choices.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 240 : 0
    selectionTimer.current = window.setTimeout(() => onChoose(id), delay)
  }
  const [page, setPage] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    function paginate() {
      if (!element.clientWidth) return
      // A page is one horizontal row; narrow viewports use fewer columns.
      const perPage = Math.max(1, Math.min(3, Math.floor((element.clientWidth + 10) / 250)))
      const result = []
      for (let index = 0; index < choices.length; index += perPage) result.push(choices.slice(index, index + perPage))
      setGroups(result.length ? result : [[]])
      setPage(current => Math.min(current, Math.max(0, result.length - 1)))
    }
    const observer = new ResizeObserver(paginate)
    observer.observe(element); paginate()
    return () => observer.disconnect()
  }, [choices, en])
  return <div className={`choice-area${choices.length > 1 ? ' branching' : ''}${selected !== null ? ' committing' : ''}`} data-selected={selected || undefined}>
    <div className="choices" ref={ref} style={{ '--choice-count': groups[page]?.length || 1 }}>{groups[page]?.map((choice, index) =>
      <ChoiceOption key={choice.id} choice={choice} index={index} single={choices.length === 1} locked={locked} selected={selected} en={en}
        onSelect={select} onDetail={value => { setDetailRead(false); setDetail(value) }} />)}</div>
    {detail && <Modal title={en ? 'Read option' : '选项详情'} onClose={() => setDetail(null)} en={en} className="choice-detail">
      <div className="choice-detail-body"><TextPages text={detail.label} en={en} onLastPage={setDetailRead} />
        <button className="primary" disabled={!detailRead || locked || selected !== null || detail.disabled} onClick={() => { select(detail.id); setDetail(null) }}>{en ? 'Choose this route' : '选择这条路线'}</button>
      </div>
    </Modal>}
    <div className="choice-pagination">{groups.length > 1 && <><button aria-label={en ? 'Previous choices' : '上一组选项'} title={en ? 'Previous choices' : '上一组选项'} disabled={!page} onClick={() => setPage(page - 1)}>‹</button><span>{en ? 'Choices' : '选项'} {page + 1} / {groups.length}</span><button aria-label={en ? 'More choices' : '更多选项'} title={en ? 'More choices' : '更多选项'} disabled={page === groups.length - 1} onClick={() => setPage(page + 1)}>›</button></>}</div>
  </div>
}
