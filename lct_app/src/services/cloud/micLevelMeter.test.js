// Test intent: see micLevelMeter.js. A fake audio graph stands in for Web Audio; no microphone is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMicLevelMeter, levelFromSamples, SILENCE_LEVEL } from './micLevelMeter.js';

function fakeAudio(fill = 0) {
  const state = { connected: [], closed: 0, disconnected: 0, resumed: 0, fill };
  class Context {
    createMediaStreamSource(stream) {
      state.stream = stream;
      return { connect: node => state.connected.push(node), disconnect: () => { state.disconnected += 1; } };
    }
    createAnalyser() {
      const analyser = { fftSize: 0, kind: 'analyser', getFloatTimeDomainData: samples => samples.fill(state.fill) };
      state.analyser = analyser;
      return analyser;
    }
    resume() { state.resumed += 1; return Promise.resolve(); }
    close() { state.closed += 1; return Promise.resolve(); }
    get destination() { return { kind: 'destination' }; }
  }
  return { state, Context };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('microphone level', () => {
  it('reads silence as zero and full scale as one', () => {
    expect(levelFromSamples(new Float32Array(64))).toBe(0);
    expect(levelFromSamples(new Float32Array(64).fill(1))).toBe(1);
    expect(levelFromSamples(new Float32Array(0))).toBe(0);
  });

  it('separates ordinary speech from a muted or dead input', () => {
    // About -26 dBFS: quiet conversational speech after gain control.
    expect(levelFromSamples(new Float32Array(512).fill(0.05))).toBeGreaterThan(SILENCE_LEVEL * 4);
    // About -66 dBFS: the noise floor of an input that is not picking anyone up.
    expect(levelFromSamples(new Float32Array(512).fill(0.0005))).toBeLessThan(SILENCE_LEVEL);
  });

  it('grows with loudness', () => {
    const quiet = levelFromSamples(new Float32Array(512).fill(0.01));
    const loud = levelFromSamples(new Float32Array(512).fill(0.3));
    expect(loud).toBeGreaterThan(quiet);
  });

  it('reports the level of the given stream on an interval', () => {
    const { state, Context } = fakeAudio(0.05);
    const stream = { id: 'synthetic' }, levels = [];
    const meter = createMicLevelMeter(stream, value => levels.push(value), { AudioContextClass: Context, intervalMs: 100 });
    expect(meter.supported).toBe(true);
    expect(state.stream).toBe(stream);
    vi.advanceTimersByTime(350);
    expect(levels).toHaveLength(3);
    expect(levels[0]).toBeCloseTo(levelFromSamples(new Float32Array(512).fill(0.05)), 5);
    meter.stop();
  });

  it('only measures: the microphone is never routed to the speakers', () => {
    const { state, Context } = fakeAudio();
    createMicLevelMeter({}, () => {}, { AudioContextClass: Context }).stop();
    expect(state.connected).toEqual([state.analyser]);
  });

  it('stops reporting and releases the audio graph on stop, once', () => {
    const { state, Context } = fakeAudio(0.05);
    const levels = [];
    const meter = createMicLevelMeter({}, value => levels.push(value), { AudioContextClass: Context, intervalMs: 100 });
    vi.advanceTimersByTime(100);
    meter.stop(); meter.stop();
    vi.advanceTimersByTime(1000);
    expect(levels).toHaveLength(1);
    expect(state.closed).toBe(1);
    expect(state.disconnected).toBe(1);
  });

  it('degrades to unsupported without Web Audio, without a stream, or when the graph cannot be built', () => {
    const onLevel = vi.fn();
    expect(createMicLevelMeter({}, onLevel, { AudioContextClass: undefined }).supported).toBe(false);
    expect(createMicLevelMeter(null, onLevel, { AudioContextClass: fakeAudio().Context }).supported).toBe(false);
    class Broken { constructor() { this.closed = 0; } createMediaStreamSource() { throw new Error('no source'); } close() { Broken.closed = true; } }
    const meter = createMicLevelMeter({}, onLevel, { AudioContextClass: Broken });
    expect(meter.supported).toBe(false);
    expect(Broken.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onLevel).not.toHaveBeenCalled();
    expect(() => meter.stop()).not.toThrow();
  });
});
