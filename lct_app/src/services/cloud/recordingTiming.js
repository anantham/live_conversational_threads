const KEY = 'lct.recording_timing.v1';
const STAGES = ['setup', 'microphone', 'authorizing', 'connecting', 'recording', 'finalizing', 'saving'];
const OUTCOMES = ['success', 'error', 'cancelled', 'timeout'];

export function recordRecordingTiming(stage, mode, startedAt, outcome) {
  if (!STAGES.includes(stage) || !['local', 'transcription', 'private-save', 'setup'].includes(mode) || !OUTCOMES.includes(outcome)) return;
  try {
    const old = JSON.parse(localStorage.getItem(KEY) || '[]');
    const saved = Array.isArray(old) ? old.filter(item => STAGES.includes(item?.stage) && ['local', 'transcription', 'private-save', 'setup'].includes(item?.mode) && OUTCOMES.includes(item?.outcome) && Number.isFinite(item?.durationMs))
      .map(({ stage: name, mode: group, durationMs, outcome: result }) => ({ stage: name, mode: group, durationMs, outcome: result, retryCount: 0 })) : [];
    localStorage.setItem(KEY, JSON.stringify([...saved, { stage, mode, durationMs: Math.max(0, Math.round(Date.now() - startedAt)), outcome, retryCount: 0 }].slice(-12)));
  } catch { /* Optional payload-free timing never blocks capture. No automatic retry. */ }
}
