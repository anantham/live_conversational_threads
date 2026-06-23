import { describe, it, expect } from "vitest";

import {
  buildWav,
  concatPcmFrames,
  encodeWav,
  pcmBytesForSeconds,
  WAV_HEADER_BYTES,
} from "./wavEncoder";

const ascii = (view, offset, len) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

describe("concatPcmFrames", () => {
  it("concatenates frame buffers in order", () => {
    const a = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = new Uint8Array([5, 6]).buffer;
    expect(Array.from(concatPcmFrames([a, b]))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns empty for no frames", () => {
    expect(concatPcmFrames([]).byteLength).toBe(0);
  });
});

describe("pcmBytesForSeconds", () => {
  it("computes int16-mono byte counts", () => {
    expect(pcmBytesForSeconds(1, 16000)).toBe(32000); // 16000 * 2 bytes
    expect(pcmBytesForSeconds(1.2, 16000)).toBe(38400);
  });
  it("never returns zero", () => {
    expect(pcmBytesForSeconds(0, 16000)).toBe(1);
  });
});

describe("buildWav", () => {
  it("writes a valid 44-byte RIFF/WAVE header for 16 kHz mono int16", () => {
    const pcm = new Uint8Array(8); // 4 samples of silence
    const buf = buildWav(pcm, 16000);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);

    const view = new DataView(buf);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
  });

  it("preserves the PCM payload after the header", () => {
    const buf = buildWav(new Uint8Array([10, 20, 30, 40]), 16000);
    expect(Array.from(new Uint8Array(buf, WAV_HEADER_BYTES))).toEqual([10, 20, 30, 40]);
  });

  it("honors a non-default sample rate", () => {
    const view = new DataView(buildWav(new Uint8Array(4), 8000));
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(16000); // 8000 * 2
  });
});

describe("encodeWav", () => {
  it("wraps the WAV bytes in an audio/wav Blob of the right size", () => {
    const pcm = new Uint8Array(8);
    const blob = encodeWav(pcm, 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(WAV_HEADER_BYTES + pcm.byteLength);
  });
});
