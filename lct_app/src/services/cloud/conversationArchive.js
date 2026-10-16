import { saveLocalConversation } from './localConversationStore.js';

/** One conversation owns its write queue; retries retain every uncommitted chunk. */
export class ConversationArchive {
  constructor(recording, { mode = 'local', write = saveLocalConversation, onStatus = () => {}, initial = null } = {}) {
    this.mode = mode; this.write = write; this.onStatus = onStatus;
    this.snapshot = { id: recording.id, recording, title: 'Recorded conversation', transcript: { finalText: '', partialText: '', finalTokens: [], partialTokens: [] }, map: null, stage: 'idle', segments: [], updatedAt: Date.now() };
    this.chunks = []; this.revision = 0; this.saved = 0; this.failed = false; this.running = null;
    this.expectedRevision = initial?.revision ?? null;
    if (initial) this.snapshot = initial;
  }
  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: Date.now() };
    this.snapshot.title = this.snapshot.map?.conversation_title || this.snapshot.transcript.finalText?.trim().slice(0, 80) || 'Recorded conversation';
    this.revision++;
    if (this.mode === 'ephemeral') { this.onStatus({ state: 'ephemeral' }); return; }
    if (!this.chunks.length && !this.snapshot.segments?.length && !this.snapshot.transcript?.finalTokens?.length && !this.snapshot.map) { this.onStatus({ state: 'waiting' }); return; }
    if (this.failed) return;
    this.onStatus({ state: 'saving' });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 200);
  }
  append(chunk) { if (this.mode !== 'ephemeral') this.chunks.push({ ...chunk, recordingId: this.snapshot.id }); this.update({}); }
  async flush({ retry = false } = {}) {
    clearTimeout(this.timer); this.timer = null;
    if (retry) this.failed = false;
    if (this.mode === 'ephemeral' || this.failed || (!this.chunks.length && !this.snapshot.segments?.length && !this.snapshot.transcript?.finalTokens?.length && !this.snapshot.map)) return;
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.saved < this.revision && !this.failed) {
        const revision = this.revision, count = this.chunks.length, snapshot = this.snapshot;
        try {
          this.expectedRevision = await this.write(snapshot, this.chunks.slice(0, count), this.expectedRevision);
          this.chunks.splice(0, count); this.saved = revision;
          if (this.saved === this.revision) this.onStatus({ state: 'saved', at: Date.now() });
        } catch (error) { this.failed = true; this.onStatus({ state: 'error', message: error?.code === 'archive_conflict' ? error.message : 'Not saved on this device. Keep this tab open, download your files or retry browser saving.' }); }
      }
    })();
    try { await this.running; } finally { this.running = null; }
  }
}
