import { RecordingSession } from './recordingSession.js';

const empty = () => ({ finalText: '', partialText: '', finalTokens: [], partialTokens: [] });

/** Conversation lifetime; each resumed segment has its own bounded provider connection. */
export class CloudConversationSession {
  constructor({ SessionClass = RecordingSession, ...callbacks } = {}) {
    this.SessionClass = SessionClass;
    this.callbacks = callbacks;
    this.state = 'idle';
    this.epoch = 0;
    this.segments = [];
    this.transcript = empty();
    this.usedMs = 0;
    this.segmentNumber = 0;
  }
  stage(value) {
    this.state = value.stage;
    this.callbacks.onStage?.({ ...value, elapsedOffsetMs: this.usedMs });
  }
  async start(options) {
    this.options = options;
    return this.beginSegment();
  }
  async beginSegment() {
    const remaining = Math.floor(this.options.maxSessionSeconds - this.usedMs / 1000);
    if (remaining < (this.options.transcribe ? 15 : 1)) {
      this.stage({ stage: 'stopped', startedAt: Date.now(), message: 'Conversation duration limit reached. Download or save your conversation.' });
      return;
    }
    const epoch = ++this.epoch, number = ++this.segmentNumber;
    const base = this.transcript.finalTokens;
    const offset = Math.max(this.usedMs, ...base.map(t => t.endMs || t.startMs || 0));
    this.pauseRequested = false;
    this.captureStarted = null;
    const normalize = tokens => (tokens || []).map(token => ({ ...token,
      speaker: number > 1 && token.speaker ? `segment-${number}:${token.speaker}` : token.speaker,
      startMs: token.startMs == null ? null : token.startMs + offset,
      endMs: token.endMs == null ? null : token.endMs + offset,
    }));
    const next = new this.SessionClass({
      onStage: value => {
        if (epoch !== this.epoch) return;
        if (value.stage === 'recording') this.captureStarted = Date.now();
        if (value.stage !== 'recording' && this.captureStarted != null) {
          this.usedMs += Math.max(0, Date.now() - this.captureStarted);
          this.captureStarted = null;
        }
        if (value.stage === 'stopped' && this.pauseRequested) value = { ...value, stage: 'paused', message: 'Paused. Microphone off. Resume to continue this conversation.' };
        this.stage(value);
      },
      onTranscript: snapshot => {
        if (epoch !== this.epoch) return;
        const added = normalize(snapshot.finalTokens);
        const separator = base.length && added.length ? [{ text: '\n', speaker: null, startMs: null, endMs: null }] : [];
        const finalTokens = [...base, ...separator, ...added];
        const partialTokens = normalize(snapshot.partialTokens);
        this.transcript = { finalTokens, partialTokens, finalText: finalTokens.map(t => t.text).join(''), partialText: snapshot.partialText || '' };
        this.callbacks.onTranscript?.(this.transcript);
      },
      onAudio: audio => {
        if (epoch !== this.epoch) return;
        this.segments.push({ ...audio, number });
        this.emitAudio();
      },
      onFailure: failure => { if (epoch === this.epoch) this.callbacks.onFailure?.(failure); },
    });
    this.current = next;
    await next.start({ ...this.options, maxSessionSeconds: remaining });
  }
  emitAudio() {
    if (!this.segments.length) return;
    this.callbacks.onAudio?.({ ...this.segments.at(-1), complete: this.segments.every(s => s.complete), segments: [...this.segments] });
  }
  pause() {
    if (this.state !== 'recording') return Promise.resolve();
    this.pauseRequested = true;
    return this.current.stop();
  }
  resume() {
    if (this.state !== 'paused') return Promise.resolve();
    return this.beginSegment();
  }
  stop() {
    this.pauseRequested = false;
    if (this.state === 'paused') {
      this.stage({ stage: 'stopped', startedAt: Date.now(), message: 'Conversation complete.' });
      return Promise.resolve();
    }
    return this.current?.stop();
  }
  cancel() {
    this.pauseRequested = false;
    if (this.state === 'paused') this.stage({ stage: 'cancelled', startedAt: Date.now(), message: 'Conversation ended. Captured segments are preserved.' });
    else this.current?.cancel();
    this.epoch++;
  }
}
