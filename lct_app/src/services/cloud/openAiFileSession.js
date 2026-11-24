import { importFileType, importWait } from './audioImportFile.js';
import { transcribeAudio } from '../serverless/sttClient.js';

export class OpenAIFileSession {
  constructor({ key, onStage, onAudio, onTranscript }) {
    Object.assign(this, { key, onStage, onAudio, onTranscript });
    this.controller = new AbortController();
  }

  async start({ file }) {
    const signal = this.controller.signal;
    const mimeType = importFileType(file);
    const upload = file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
    this.onAudio({ blob: upload, mimeType, complete: true,
      segments: [{ number: 1, blob: upload, mimeType, complete: true }] });
    this.onStage({ stage: 'transcribing', message: 'Transcribing your audio with OpenAI.', startedAt: Date.now() });
    try {
      const response = await importWait(transcribeAudio(this.key, upload, { signal, redactErrors: true }), signal, 125_000);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const finalTokens = response.segments.filter(row => row.text && Number.isFinite(row.start) && Number.isFinite(row.end)
        && row.start >= 0 && row.end >= row.start).map((row, index) => ({
        text: (index ? '\n' : '') + row.text, speaker: row.speaker,
        startMs: Math.round(row.start * 1000), endMs: Math.round(row.end * 1000),
      }));
      if (!finalTokens.length) throw new Error('OpenAI returned no usable speaker passages. Your original audio is preserved.');
      const transcript = { finalTokens, finalText: finalTokens.map(token => token.text).join(''), partialText: '', partialTokens: [] };
      this.onTranscript(transcript);
      this.onStage({ stage: 'stopped', message: 'Transcript ready.', startedAt: Date.now() });
      return transcript;
    } catch (error) {
      if (!signal.aborted) this.onStage({ stage: 'error', message: error.message, startedAt: Date.now() });
      throw error;
    } finally {
      this.controller.abort();
    }
  }

  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.onStage({ stage: 'cancelled', message: 'Import stopped. Your original audio is preserved.', startedAt: Date.now() });
  }
}
