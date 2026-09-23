const QUICK_START_KEY = 'gflow.quickStart.completed';
export const QUICK_START_FLOW_VERSION = 6;
export function quickStartStepStorageKey(progressOwner) {
  return progressOwner ? `gflow.quickStart.step.v${QUICK_START_FLOW_VERSION}.${progressOwner}` : `gflow.quickStart.step.v${QUICK_START_FLOW_VERSION}`;
}
export function shouldResumeQuickStartProgress(mode, progressOwner) {
  return true;
}
function stepKey(progressOwner) {
  return quickStartStepStorageKey(progressOwner);
}
export function readQuickStartCompleted() {
  try {
    return window.localStorage.getItem(QUICK_START_KEY) === 'true';
  } catch {
    return false;
  }
}
export function readQuickStartStepId(progressOwner) {
  try {
    return window.localStorage.getItem(stepKey(progressOwner)) || '';
  } catch {
    return '';
  }
}
export function writeQuickStartStepId(progressOwner, stepId) {
  if (!stepId) return;
  try {
    window.localStorage.setItem(stepKey(progressOwner), stepId);
  } catch {}
}
export function clearQuickStartStepId(progressOwner) {
  try {
    window.localStorage.removeItem(stepKey(progressOwner));
  } catch {}
}
export function writeQuickStartCompleted() {
  try {
    window.localStorage.setItem(QUICK_START_KEY, 'true');
  } catch {}
}
function hintKey(progressOwner) {
  return progressOwner ? `gflow.contextualHints.${progressOwner}` : 'gflow.contextualHints';
}
export function readSeenHints(progressOwner) {
  try {
    const raw = window.localStorage.getItem(hintKey(progressOwner));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
export function markHintSeen(progressOwner, hintId) {
  const seen = {
    ...readSeenHints(progressOwner),
    [hintId]: true
  };
  try {
    window.localStorage.setItem(hintKey(progressOwner), JSON.stringify(seen));
  } catch {}
  return seen;
}
