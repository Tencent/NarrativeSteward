import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlaytest } from '../hooks/usePlaytest';
import { playtestMissingCharacterArt, playtestMissingLocationArt } from '../playtestVisuals';
import { playtestSessionDecision } from '../playtestSessionPolicy';
import { shouldAdvanceGuidePlaytest, shouldAutoStartGuidePlaytest } from '../playtestGuide';
import { playtestCitableEdgeIds, resolvePlaytestCurrent } from '../playtestContext';
import { useT } from '../i18n';
import { ConceptHelpTrigger } from './ConceptHelpContext';
import { tZh } from '../i18n/translate.js';
import { formatStateVariableValue } from '../stateVariableValues';
function beatKindLabels(t = tZh) {
  return {
    narration: t('playtest.kinds.narration'),
    monologue: t('playtest.kinds.monologue'),
    dialogue: t('playtest.kinds.dialogue'),
    choice: t('playtest.kinds.choice')
  };
}
const BEAT_KIND_LABEL = beatKindLabels();
const HAS_SPEAKER = (kind) => kind === 'dialogue' || kind === 'monologue';
function speakerCaption(beat, t = tZh) {
  if (beat?.speakerDisplayName) return beat.speakerDisplayName;
  if (beat?.speaker) return t('artifacts.speaker.unrecognized');
  return '';
}
function HistoryItem({
  item
}) {
  const t = useT();
  if (item.kind === 'event_enter') {
    return <div className="pt-item pt-event-enter">
        {item.label && <div className="pt-choice-echo">→ {item.label}</div>}
        <div className="pt-event-title">{t('playtest.eventEnter', {
          title: item.title
        })}</div>
      </div>;
  }
  if (item.kind === 'beat_choice' || item.kind === 'event_choice') {
    return <div className="pt-choice-echo">→ {item.label}</div>;
  }
  const b = item.beat;
  if (HAS_SPEAKER(b.kind)) {
    const name = speakerCaption(b, t);
    return <div className={`pt-item pt-beat pt-beat-${b.kind}`}>
        {name && <span className="pt-speaker">{name}</span>}
        <span className="pt-content">{b.kind === 'monologue' ? t('playtest.monologueWrap', {
          text: b.content
        }) : b.content}</span>
      </div>;
  }
  return <div className={`pt-item pt-beat pt-beat-${b.kind}`}>
      <span className="pt-content">{b.content}</span>
    </div>;
}
function computeStage(history) {
  const sides = {};
  let lastSpeaker = null;
  let lastSide = 'right';
  let currentIndex = -1;
  history.forEach((item, i) => {
    if (item.kind !== 'beat') return;
    currentIndex = i;
    const b = item.beat;
    if (HAS_SPEAKER(b.kind) && b.speaker && (item.isCharacterSpeaker || b.isCharacterSpeaker)) {
      if (b.speaker !== lastSpeaker) {
        lastSide = lastSide === 'left' ? 'right' : 'left';
        lastSpeaker = b.speaker;
      }
      sides[i] = lastSide;
    }
  });
  return {
    sides,
    currentIndex
  };
}
function StateDrawer({
  vars,
  varList
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div className="pt-state-drawer">
      <button type="button" className="btn btn-small pt-state-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t('playtest.stateDrawerCount', {
        count: varList.length
      })}{open ? '▲' : '▼'}
      </button>
      {open && <div className="pt-state-list">
          {varList.length === 0 && <div className="muted">{t('playtest.noVariables')}</div>}
          {varList.map((v) => <div className="pt-state-row" key={v.id}>
              <span className="pt-state-name">{v.name || v.id}</span>
              <span className="pt-state-value">
                {formatStateVariableValue(v, vars[v.id])}
              </span>
            </div>)}
        </div>}
    </div>;
}
function StageCaption({
  beat
}) {
  const t = useT();
  if (!beat) return null;
  const name = speakerCaption(beat, t);
  const isSpeech = HAS_SPEAKER(beat.kind) && name;
  return <div className="pt-stage-caption">
      {isSpeech && <span className="pt-speaker">{name}</span>}
      <span className="pt-content">{beat.kind === 'monologue' ? t('playtest.monologueWrap', {
        text: beat.content
      }) : beat.content}</span>
    </div>;
}
export default function PlaytestPanel({
  projectId,
  disabled,
  agentTurnActive = false,
  contentVersionKey = '',
  playtestTarget = null,
  onBackToBuild,
  onContextChange,
  onCiteChoice
}) {
  const t = useT();
  const pt = usePlaytest(projectId);
  const lastOutcomeRef = useRef(null);
  const startedGuideRef = useRef(false);
  const seekChoiceKeyRef = useRef('');
  const [startedVersionKey, setStartedVersionKey] = useState('');
  const sessionStarted = pt.status !== 'idle';
  const {
    interactionLocked,
    mustRestart
  } = playtestSessionDecision({
    started: sessionStarted,
    startedVersionKey,
    currentVersionKey: contentVersionKey,
    agentTurnActive
  });
  const actionsLocked = interactionLocked || mustRestart || pt.isAdvancing;
  const {
    sides,
    currentIndex
  } = useMemo(() => computeStage(pt.history), [pt.history]);
  const currentItem = currentIndex >= 0 ? pt.history[currentIndex] : null;
  const side = currentIndex >= 0 ? sides[currentIndex] : 'left';
  const beatCount = pt.history.filter((h) => h.kind === 'beat').length;
  const eventTitle = currentItem?.eventTitle || pt.blockedEvent?.title || pt.ending?.title || '';
  const beatPreview = currentItem?.beat?.content || '';
  const current = useMemo(() => resolvePlaytestCurrent(pt.current, pt.history, pt.blockedEvent), [pt.blockedEvent, pt.current, pt.history]);
  useLayoutEffect(() => {
    onContextChange?.({
      status: pt.status,
      current,
      vars: pt.vars,
      takenEdges: pt.takenEdges,
      choices: pt.choices,
      eventTitle,
      beatPreview,
      citableEdgeIds: playtestCitableEdgeIds(pt.choices),
      mustRestart,
      started: sessionStarted
    });
  }, [beatPreview, current, eventTitle, mustRestart, onContextChange, pt.choices, pt.status, pt.takenEdges, pt.vars, sessionStarted]);
  useEffect(() => {
    if (!shouldAutoStartGuidePlaytest(playtestTarget) || disabled || agentTurnActive) return;
    if (startedGuideRef.current) return;
    if (pt.status !== 'idle') return;
    startedGuideRef.current = true;
    setStartedVersionKey(contentVersionKey);
    pt.start();
  }, [agentTurnActive, contentVersionKey, disabled, playtestTarget, pt.status, pt.start]);
  useEffect(() => {
    if (disabled || actionsLocked || pt.status !== 'playing') return;
    const enabled = (pt.choices || []).filter((choice) => !choice.disabled);
    if (!shouldAdvanceGuidePlaytest(playtestTarget, enabled.length)) return;
    const choiceId = enabled[0].id;
    const key = `${playtestTarget}:${choiceId}:${beatCount}`;
    if (seekChoiceKeyRef.current === key) return;
    seekChoiceKeyRef.current = key;
    pt.choose(choiceId);
  }, [actionsLocked, beatCount, disabled, playtestTarget, pt.choices, pt.choose, pt.status]);
  const startPlaytest = (restart) => {
    if (disabled || interactionLocked) return;
    lastOutcomeRef.current = null;
    setStartedVersionKey(contentVersionKey);
    pt.start();
  };
  const choose = (choice) => {
    if (actionsLocked) return;
    pt.choose(choice.id);
  };
  const undo = () => {
    if (actionsLocked) return;
    pt.undo();
  };
  const citeChoice = (choice, event) => {
    event?.stopPropagation();
    event?.preventDefault();
    if (!choice?.edge?.id) return;
    onCiteChoice?.(choice);
  };
  if (disabled) {
    return <div className="playtest-panel">
        <div className="objlist-empty">{t('playtest.unavailableGenerating')}</div>
      </div>;
  }
  if (pt.status === 'idle') {
    return <div className="playtest-panel" data-quickstart="playtest-panel">
        <ConceptHelpTrigger conceptId="playtest" />
        {interactionLocked && <div className="pt-session-banner is-paused" role="status" aria-live="polite">
            {t('playtest.agentBusyStart')}
          </div>}
        <div className="objlist-empty">
          {t('playtest.startHint')}
        </div>
        <button type="button" className="btn btn-primary" data-quickstart="playtest-start" onClick={() => startPlaytest(false)} disabled={interactionLocked}>
          ▶ {t('playtest.start')}
        </button>
      </div>;
  }
  const bgImage = currentItem?.bgImage;
  const charImage = currentItem?.charImage;
  const beat = currentItem?.beat;
  const locationName = currentItem?.locationName;
  const missingLocationImage = Boolean(currentItem?.missingLocationImage);
  const missingCharacterImage = Boolean(currentItem?.missingCharacterImage);
  return <div className="playtest-panel" data-quickstart="playtest-panel">
      <ConceptHelpTrigger conceptId="playtest" />
      {mustRestart && <div className="pt-session-banner is-stale" role="status" aria-live="polite">
          {t('playtest.contentUpdated')}
        </div>}
      {interactionLocked && <div className="pt-session-banner is-paused" role="status" aria-live="polite">
          {t('playtest.agentPaused')}
        </div>}
      <div className="pt-toolbar">
        <button type="button" className="btn btn-small btn-ghost" onClick={undo} disabled={!pt.canUndo || actionsLocked}>
          ↶ {t('playtest.back')}
        </button>
        <button type="button" className={`btn btn-small ${mustRestart ? 'btn-primary' : 'btn-ghost'}`} data-quickstart="playtest-start" onClick={() => startPlaytest(true)} disabled={interactionLocked || pt.isAdvancing}>
          ↻ {t('playtest.restartShort')}
        </button>
      </div>

      {}
      <div className={`pt-stage${bgImage ? '' : ' is-plain'}${missingLocationImage ? ' has-missing-location' : ''}`} data-quickstart="playtest-stage" style={bgImage ? {
      backgroundImage: `url("${bgImage}")`
    } : undefined}>
        <div className="pt-stage-scrim" />
        {locationName && <div className={`pt-stage-place${missingLocationImage ? ' has-missing' : ''}`}>
            <span className="pt-stage-place-name">📍 {locationName}</span>
            {missingLocationImage && <span className="pt-missing-art">{playtestMissingLocationArt(t)}</span>}
          </div>}
        <StateDrawer vars={pt.vars} varList={pt.varList} />
        {charImage ? <img className={`pt-portrait pt-portrait-${side}`} src={charImage} alt={speakerCaption(beat, t)} /> : missingCharacterImage ? <div className={`pt-portrait pt-portrait-missing pt-portrait-${side}`}>
            <span className="pt-portrait-name">{speakerCaption(beat, t)}</span>
            <span className="pt-missing-art">{playtestMissingCharacterArt(t)}</span>
          </div> : null}

        {}
        <div className="pt-stage-panel">
          <StageCaption beat={beat} />

          {pt.status === 'loading' && <div className="pt-stage-note muted">{t('artifacts.materials.loading')}</div>}

          {pt.status === 'error' && <div className="pt-stage-note pt-note-warn">{pt.errorMsg}</div>}

          {pt.status === 'blocked' && <div className="pt-stage-note pt-note-warn">
              {t('playtest.blockedScene', {
            title: pt.blockedEvent?.title
          })}
              <div className="pt-note-sub">{t('playtest.blockedHint')}</div>
            </div>}

          {pt.status === 'dead_end' && <div className="pt-stage-note pt-note-warn">
              {t('playtest.deadEndStory')}
              <div className="pt-note-sub">{pt.deadEndInfo}</div>
              <div className="pt-note-sub">{t('playtest.retryChoice')}</div>
            </div>}

          {pt.status === 'ending' && <div className="pt-ending-card" data-quickstart="playtest-ending" role="status">
              <div className="pt-ending-kicker">{t('playtest.reachedEnding')}</div>
              <h3 className="pt-ending-title">{pt.ending?.title || t('playtest.ending')}</h3>
              {pt.ending?.summary && <p className="pt-ending-summary">{pt.ending.summary}</p>}
              <div className="pt-ending-actions">
                <button type="button" className="btn btn-primary btn-small" onClick={() => startPlaytest(true)} disabled={interactionLocked || pt.isAdvancing}>
                  {t('playtest.restart')}
                </button>
                {onBackToBuild && <button type="button" className="btn btn-small" onClick={onBackToBuild}>
                    {t('playtest.backToBuild')}
                  </button>}
              </div>
            </div>}

          {(pt.status === 'playing' || pt.status === 'dead_end') && pt.choices.length > 0 && <div className="pt-stage-choices" data-quickstart="playtest-choices">
              {pt.choices.length === 1 && !pt.choices[0].disabled ? <div className="pt-choice-row is-next">
                  <button type="button" className="btn-vn btn-vn-next" onClick={() => choose(pt.choices[0])} disabled={actionsLocked}>
                    {t('playtest.nextArrow')}
                  </button>
                  {pt.choices[0].edge?.id && <button type="button" className="pt-cite" onClick={(event) => citeChoice(pt.choices[0], event)}>
                      {t('playtest.citeChoice')}
                    </button>}
                </div> : pt.choices.map((c) => <div className="pt-choice-row" key={c.id}>
                    <button type="button" className={`btn-vn${c.disabled ? ' btn-vn-disabled' : ''}`} onClick={() => choose(c)} disabled={c.disabled || actionsLocked} title={c.disabledReason || undefined}>
                      <span>{c.label}</span>
                      {c.disabled && c.disabledReason && <span className="btn-vn-reason">{t('playtest.locked', {
                  reason: c.disabledReason
                })}</span>}
                    </button>
                    {c.edge?.id && <button type="button" className="pt-cite" onClick={(event) => citeChoice(c, event)}>
                        {t('playtest.citeChoice')}
                      </button>}
                  </div>)}
            </div>}
        </div>
      </div>

      {}
      {beatCount > 0 && <details className="pt-log">
          <summary>{t('playtest.historyLog', {
          count: beatCount
        })}</summary>
          <div className="pt-history">
            {pt.history.map((item, i) => <HistoryItem item={item} key={i} />)}
          </div>
        </details>}
    </div>;
}
export { BEAT_KIND_LABEL };
