import { SonioxStream } from './sonioxStream.js';
import { requestTranscriptionSession, validateTranscriptionSession } from './sonioxSessionClient.js';
import { decodeAudioImport, importDelay, importWait, cancelledImport, IMPORT_RATE } from './audioImportFile.js';

/** One original file, one temporary key, one stream. No automatic retry. */
export class AudioImportSession {
  constructor({ onStage, onAudio, onTranscript, StreamClass = SonioxStream,
    decode = decodeAudioImport, requestSession = requestTranscriptionSession, validateSession = validateTranscriptionSession } = {}) {
    Object.assign(this, { onStage, onAudio, onTranscript, StreamClass, decode, requestSession, validateSession });
    this.state = 'idle'; this.generation = 0;
  }
  stage(stage, message, progress = null) { this.state = stage; this.onStage?.({ stage, message, progress, startedAt: Date.now() }); }
  async start({ file, maxSessionSeconds, signal } = {}) {
    if (this.running || !['idle', 'stopped', 'cancelled', 'error'].includes(this.state)) throw new Error('An audio import is already active.');
    this.running = true;
    const generation = ++this.generation;
    this.abort = new AbortController();
    const abort = () => this.abort.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const current = () => {
      if (generation !== this.generation || this.abort.signal.aborted) throw cancelledImport();
    };
    this.transcript = { finalText: '', partialText: '', finalTokens: [], partialTokens: [] };
    this.stream = null; this.failure = null;
    try {
      current(); this.stage('preparing', 'Reading audio on this device.');
      const decoded = await this.decode(file, { maxSeconds: maxSessionSeconds, signal: this.abort.signal });
      current();
      if (!(decoded.pcm instanceof ArrayBuffer) || !decoded.pcm.byteLength || decoded.pcm.byteLength % 2 ||
          decoded.durationMs !== decoded.pcm.byteLength / 2 / IMPORT_RATE * 1000 ||
          decoded.durationMs > maxSessionSeconds * 1000) throw new Error('Audio import returned invalid decoded audio.');
      const blob = file.slice(0, file.size, decoded.mimeType);
      this.onAudio?.({ blob, mimeType: decoded.mimeType, complete: true, segments: [{ number: 1, blob, mimeType: decoded.mimeType, complete: true }] });
      this.stage('authorizing', 'Authorizing transcription.');
      const key = this.validateSession(await importWait(this.requestSession({ signal: this.abort.signal }), this.abort.signal, 10000));
      current();
      if (decoded.durationMs > key.max_session_seconds * 1000) throw new Error('Audio import exceeds the current provider session limit. No audio was sent.');
      this.stream = new this.StreamClass({
        onTranscript: value => {
          if (generation !== this.generation || this.abort.signal.aborted) return;
          this.transcript = value; this.onTranscript?.(value);
        },
        onFailure: error => { if (generation === this.generation) { this.failure = error; this.abort.abort(); } },
      });
      this.stage('connecting', 'Connecting transcription.');
      await importWait(this.stream.connect({ apiKey: key.api_key, expiresAt: key.expires_at,
        maxSessionSeconds: key.max_session_seconds, audioFormat: 'pcm_s16le', sampleRate: IMPORT_RATE, numChannels: 1,
        signal: this.abort.signal }), this.abort.signal, 10000);
      current(); this.stage('transcribing', 'Transcribing your audio.', 0);
      const frameBytes = IMPORT_RATE * 2 / 5;
      for (let offset = 0; offset < decoded.pcm.byteLength; offset += frameBytes) {
        current(); this.stream.sendAudio(decoded.pcm.slice(offset, offset + frameBytes));
        this.stage('transcribing', 'Transcribing your audio.', Math.min(1, (offset + frameBytes) / decoded.pcm.byteLength));
        // Five percent faster than real time, with a bounded socket buffer.
        if (offset + frameBytes < decoded.pcm.byteLength) await importDelay(190, this.abort.signal);
      }
      this.stage('finalizing', 'Finishing the transcript.');
      await importWait(this.stream.finish(), this.abort.signal, 10000);
      current();
      if (!this.transcript.finalTokens.length) throw new Error('No speech was detected. Your original audio is preserved.');
      this.transcript = { ...this.transcript, partialText: '', partialTokens: [] };
      this.onTranscript?.(this.transcript); this.stage('stopped', 'Transcript ready.', 1);
      return this.transcript;
    } catch (error) {
      if (generation !== this.generation) throw cancelledImport();
      const cause = this.failure || error;
      this.stage(this.abort.signal.aborted && !this.failure ? 'cancelled' : 'error',
        this.abort.signal.aborted && !this.failure ? 'Import stopped. Your original audio and confirmed words are preserved.' : cause.message);
      throw cause;
    } finally {
      this.running = false;
      signal?.removeEventListener('abort', abort);
      this.stream?.cancel(); this.abort.abort();
    }
  }
  cancel() {
    if (['idle', 'stopped', 'cancelled', 'error'].includes(this.state)) return;
    this.generation++; this.abort?.abort(); this.stream?.cancel();
    this.stage('cancelled', 'Import stopped. Your original audio and confirmed words are preserved.');
  }
}
