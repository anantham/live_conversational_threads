// Test Intent: tests/intent/cloud-audio-import.md. Public file/decoder outcomes.
import { describe, expect, it, vi } from 'vitest';
import { decodeAudioImport, importFileType, MAX_IMPORT_BYTES } from './audioImportFile.js';
class MetadataAudio extends EventTarget {
  duration = 0.1;
  load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  removeAttribute() { this.src = ''; }
}
class Decoder {
  async decodeAudioData() { return { sampleRate: 16000, numberOfChannels: 2, length: 1600,
    getChannelData: i => new Float32Array(1600).fill(i ? -0.25 : 0.75) }; }
}
const urls = () => ({ createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() });
function file(name) { const value = new File(['synthetic encoded audio'], name); value.arrayBuffer = async () => new ArrayBuffer(4); return value; }
const options = () => ({ maxSeconds: 300, AudioClass: MetadataAudio, ContextClass: Decoder, urlAPI: urls() });
describe('audio import decoding', () => {
  it.each([['garden.mp3', 'audio/mpeg'], ['garden.WAV', 'audio/wav'], ['garden.m4a', 'audio/mp4']])('normalizes %s to mono PCM and retains the original type', async (name, mime) => {
    const result = await decodeAudioImport(file(name), options());
    expect(result.mimeType).toBe(mime); expect(result.durationMs).toBe(100);
    expect(result.pcm.byteLength).toBe(3200);
    expect(new DataView(result.pcm).getInt16(0, true)).toBe(8192);
  });
  it('rejects unsupported, empty, oversized and long files without decoding', async () => {
    for (const value of [{ name: 'data.txt', size: 4 }, { name: 'empty.wav', size: 0 }, { name: 'huge.mp3', size: MAX_IMPORT_BYTES + 1 }]) expect(() => importFileType(value)).toThrow();
    const decode = vi.fn(); class NeverDecode { decodeAudioData = decode; }
    class LongAudio extends MetadataAudio { duration = 301; }
    await expect(decodeAudioImport(file('long.m4a'), { ...options(), AudioClass: LongAudio, ContextClass: NeverDecode })).rejects.toThrow('up to 300 seconds');
    expect(decode).not.toHaveBeenCalled();
  });
  it('refuses corrupt decoded duration and cancels late metadata with URL cleanup', async () => {
    class Oversize extends Decoder { async decodeAudioData() { return { sampleRate: 16000, length: 4800001, numberOfChannels: 1 }; } }
    await expect(decodeAudioImport(file('bad.mp3'), { ...options(), ContextClass: Oversize })).rejects.toThrow('duration or channel limits');
    const controller = new AbortController(), opts = options();
    class Stalled extends MetadataAudio { load() {} }
    const pending = decodeAudioImport(file('cancel.wav'), { ...opts, AudioClass: Stalled, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(opts.urlAPI.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  });
});
