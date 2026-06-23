/**
 * WAV (RIFF) encoding for edge STT (ADR-056 Phase 1).
 *
 * The live capture hook (`useAudioCapture`) already emits 16 kHz mono int16-LE
 * PCM frames. The M5's OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * wants a WAV file, so edge STT concatenates frames and wraps them in a 44-byte
 * RIFF/WAVE header. Pure functions, no I/O — unit-tested in `wavEncoder.test.js`.
 */

export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2; // int16

/**
 * Concatenate a list of int16-LE PCM frame buffers into one Uint8Array.
 * @param {ArrayBuffer[]} frames
 * @returns {Uint8Array}
 */
export function concatPcmFrames(frames) {
  let total = 0;
  for (const frame of frames) total += frame.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(new Uint8Array(frame), offset);
    offset += frame.byteLength;
  }
  return out;
}

/**
 * Build a WAV container (header + PCM) as a raw ArrayBuffer. Pure + synchronous
 * so it's directly assertable in tests (no Blob round-trip needed).
 * @param {Uint8Array} pcmBytes raw int16-LE mono PCM
 * @param {number} sampleRateHz
 * @returns {ArrayBuffer}
 */
export function buildWav(pcmBytes, sampleRateHz = 16000) {
  const dataLen = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataLen);
  const view = new DataView(buffer);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true); // file size - 8
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLen, true);
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(pcmBytes);

  return buffer;
}

/**
 * Wrap raw int16-LE mono PCM bytes in a WAV `Blob` for multipart upload.
 * @param {Uint8Array} pcmBytes raw int16-LE mono PCM
 * @param {number} sampleRateHz
 * @returns {Blob} `audio/wav`
 */
export function encodeWav(pcmBytes, sampleRateHz = 16000) {
  return new Blob([buildWav(pcmBytes, sampleRateHz)], { type: "audio/wav" });
}

/**
 * PCM byte count for a given duration of int16-LE mono audio.
 * @param {number} seconds
 * @param {number} sampleRateHz
 * @returns {number} bytes
 */
export function pcmBytesForSeconds(seconds, sampleRateHz = 16000) {
  return Math.max(1, Math.floor(sampleRateHz * BYTES_PER_SAMPLE * seconds));
}
