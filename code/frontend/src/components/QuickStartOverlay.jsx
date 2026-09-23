import { useEffect, useMemo, useRef, useState } from 'react';
import { localizedStepsForMode, resolveStepTargets } from '../onboarding/quickStartSteps';
import { useT } from '../i18n';
import { readQuickStartStepId, shouldResumeQuickStartProgress, writeQuickStartStepId } from '../onboarding/hintStorage';
function isDisplayedTarget(node) {
  if (!(node instanceof HTMLElement)) return false;
  let current = node;
  while (current) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}
function findVisibleTarget(target) {
  const nodes = document.querySelectorAll(`[data-quickstart="${target}"]`);
  for (const node of nodes) {
    if (isDisplayedTarget(node)) return node;
  }
  return null;
}
function scrollTargetIntoView(node) {
  const scroller = node.closest('.event-inspector, .drawer-body, .chat-scroll');
  if (!scroller) return;
  const stickyHead = scroller.querySelector('.event-inspector-head, .drawer-head');
  const headHeight = stickyHead ? stickyHead.getBoundingClientRect().height : 0;
  const nodeBox = node.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const topGap = nodeBox.top - (scrollerBox.top + headHeight + 8);
  const bottomGap = nodeBox.bottom - (scrollerBox.bottom - 8);
  if (topGap < 0) scroller.scrollTop += topGap;else if (bottomGap > 0) scroller.scrollTop += bottomGap;
}
function nearestTargetNode(nodes, clientX, clientY) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const distance = (clientX - centerX) ** 2 + (clientY - centerY) ** 2;
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}
function unionBox(boxes) {
  if (!boxes.length) return null;
  const top = Math.min(...boxes.map((box) => box.top));
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return {
    top,
    left,
    width: right - left,
    height: bottom - top
  };
}
function nextPlaceTop(box, previous) {
  const mid = box.top + box.height / 2;
  const viewportHeight = window.innerHeight;
  if (previous) return mid > viewportHeight * 0.46;
  return mid > viewportHeight * 0.62;
}
const RECT_MOVE_THRESHOLD = 8;
export default function QuickStartOverlay({
  open,
  mode,
  progressOwner = null,
  onComplete,
  onDismiss,
  onStepChange
}) {
  const t = useT();
  const steps = useMemo(() => localizedStepsForMode(mode, t), [mode, t]);
  const [index, setIndex] = useState(null);
  const [spots, setSpots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [placeTop, setPlaceTop] = useState(false);
  const [measuredStepId, setMeasuredStepId] = useState(null);
  const overlayRef = useRef(null);
  const placeTopRef = useRef(false);
  const spotsRef = useRef([]);
  const step = index == null ? null : steps[index] || null;
  const paragraphs = Array.isArray(step?.body) ? step.body : step?.body ? [step.body] : [];
  useEffect(() => {
    if (!open) {
      setIndex(null);
      return;
    }
    if (!shouldResumeQuickStartProgress(mode, progressOwner)) {
      setIndex(0);
      return;
    }
    const savedId = readQuickStartStepId(progressOwner);
    const savedIndex = steps.findIndex((item) => item.id === savedId);
    setIndex(savedIndex >= 0 ? savedIndex : 0);
  }, [open, progressOwner, steps, mode]);
  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add('quickstart-open');
    return () => document.body.classList.remove('quickstart-open');
  }, [open]);
  useEffect(() => {
    if (!open || !step) {
      setMeasuredStepId(null);
      return undefined;
    }
    if (shouldResumeQuickStartProgress(mode, progressOwner)) {
      writeQuickStartStepId(progressOwner, step.id);
    }
    onStepChange?.(step);
    const targets = resolveStepTargets(step);
    if (!targets.length) {
      setSpots([]);
      spotsRef.current = [];
      setMeasuredStepId(step.id);
      return undefined;
    }
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;
    let retryTimer = 0;
    const startedAt = performance.now();
    const applySpots = (nextSpots, forcePlace) => {
      const previous = spotsRef.current;
      const moved = previous.length !== nextSpots.length || nextSpots.some((spot, index) => {
        const prior = previous[index];
        return !prior || Math.abs(prior.top - spot.top) > RECT_MOVE_THRESHOLD || Math.abs(prior.left - spot.left) > RECT_MOVE_THRESHOLD || Math.abs(prior.width - spot.width) > RECT_MOVE_THRESHOLD || Math.abs(prior.height - spot.height) > RECT_MOVE_THRESHOLD;
      });
      if (!moved && !forcePlace) return;
      const union = unionBox(nextSpots);
      if (union) {
        const nextTop = nextPlaceTop(union, placeTopRef.current);
        placeTopRef.current = nextTop;
        setPlaceTop(nextTop);
      }
      spotsRef.current = nextSpots;
      setSpots(nextSpots);
      setMeasuredStepId(step.id);
    };
    const collectSpots = (shouldScroll) => {
      const found = [];
      for (const item of targets) {
        const node = findVisibleTarget(item.target);
        if (!node) continue;
        if (shouldScroll) scrollTargetIntoView(node);
        const box = node.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        found.push({
          target: item.target,
          labelKey: item.labelKey || null,
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height
        });
      }
      return found;
    };
    const measure = (shouldScroll, allowPartial = false) => {
      if (cancelled) return false;
      const found = collectSpots(shouldScroll);
      if (!found.length) return false;
      if (!allowPartial && found.length < targets.length) return false;
      applySpots(found, shouldScroll);
      return true;
    };
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (measure(true)) return;
        const retry = () => {
          if (cancelled) return;
          if (measure(true)) return;
          if (performance.now() - startedAt > 900) {
            if (!measure(true, true)) {
              setSpots([]);
              spotsRef.current = [];
              setMeasuredStepId(step.id);
            }
            return;
          }
          retryTimer = window.setTimeout(retry, 50);
        };
        retryTimer = window.setTimeout(retry, 50);
      });
    });
    const timer = window.setInterval(() => measure(false, true), 250);
    const onResize = () => measure(false, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.clearTimeout(retryTimer);
      window.clearInterval(timer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, step, onStepChange, progressOwner, mode]);
  useEffect(() => {
    if (!open || !step) return undefined;
    const overlay = overlayRef.current;
    if (!overlay) return undefined;
    const onWheel = (event) => {
      if (event.target.closest('.quickstart-card')) return;
      const nodes = resolveStepTargets(step).map((item) => findVisibleTarget(item.target)).filter(Boolean);
      const node = nearestTargetNode(nodes, event.clientX, event.clientY);
      if (!node) return;
      const scroller = node.closest('.event-inspector, .drawer-body, .chat-scroll');
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
      event.preventDefault();
      scroller.scrollTop += event.deltaY;
    };
    overlay.addEventListener('wheel', onWheel, {
      passive: false
    });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, [open, step]);
  if (!open || !step) return null;
  const isLast = index === steps.length - 1;
  const spotlightReady = measuredStepId === step.id;
  const holes = spots.map((spot) => ({
    ...spot,
    top: Math.max(8, spot.top - 6),
    left: Math.max(8, spot.left - 6),
    width: spot.width + 12,
    height: spot.height + 12
  }));
  const finish = async () => {
    setBusy(true);
    try {
      await onComplete();
    } finally {
      setBusy(false);
    }
  };
  return <div ref={overlayRef} className="quickstart-overlay" role="dialog" aria-modal="true" aria-labelledby="quickstart-title">
      {(!spotlightReady || !holes.length) && <div className="quickstart-mask" />}
      {spotlightReady && holes.length > 0 && <>
          <svg className="quickstart-mask-svg" aria-hidden="true" width={window.innerWidth} height={window.innerHeight} viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}>
            <defs>
              <mask id="quickstart-holes">
                <rect width={window.innerWidth} height={window.innerHeight} fill="white" />
                {holes.map((hole) => <rect key={`hole-${hole.target}`} x={hole.left} y={hole.top} width={hole.width} height={hole.height} rx="10" fill="black" />)}
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(16,18,24,0.45)" mask="url(#quickstart-holes)" />
          </svg>
          {holes.map((hole) => <div key={`spot-${hole.target}`} className="quickstart-spotlight" style={{
        top: hole.top,
        left: hole.left,
        width: hole.width,
        height: hole.height
      }}>
              {hole.labelKey && <span className="quickstart-spotlight-label">{t(hole.labelKey)}</span>}
            </div>)}
        </>}
      <div className={`quickstart-card${placeTop ? ' is-top' : ''}`}>
        <p className="quickstart-progress">
          {t('help.overlay.progress', {
          current: index + 1,
          total: steps.length
        })}
        </p>
        <h2 id="quickstart-title">{step.title}</h2>
        {paragraphs.map((text) => <p key={text}>{text}</p>)}
        <div className="quickstart-actions">
          <button type="button" className="btn ghost" disabled={index === 0 || busy} onClick={() => setIndex((value) => Math.max(0, (value || 0) - 1))}>
            {t('common.previous')}
          </button>
          {!isLast ? <button type="button" className="btn primary" disabled={busy} onClick={() => setIndex((value) => Math.min(steps.length - 1, (value || 0) + 1))}>
              {step.nextLabelKey ? t(step.nextLabelKey) : t('common.next')}
            </button> : <button type="button" className="btn primary" disabled={busy} onClick={finish}>
              {busy ? t('help.overlay.saving') : t('help.overlay.finish')}
            </button>}
          {onDismiss && <button type="button" className="btn ghost" disabled={busy} onClick={onDismiss}>
              {t('help.overlay.later')}
            </button>}
        </div>
      </div>
    </div>;
}
