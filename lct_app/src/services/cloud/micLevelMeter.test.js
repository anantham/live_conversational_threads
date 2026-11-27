// Test intent: see micLevelMeter.js. A fake audio graph stands in for Web Audio; no microphone is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMicLevelMeter, levelFromSamples, SILENCE_LEVEL } from './micLevelMeter.js';

function fakeAudio(fill = 0, contextState) {
  const state = { connected: [], closed: 0, disconnected: 0, resumed: 0, fill, contextState };
  class Context {
    get state() { return state.contextState; }
    createMediaStreamSource(stream) {
      state.stream = stream;
      return { connect: node => state.connected.push(node), disconnect: () => { state.disconnected += 1; } };
    }
    createAnalyser() {
      // The analyser can be connected onwards too; that is the other way audio could reach the speakers.
      const analyser = { fftSize: 0, kind: 'analyser', connect: node => state.connected.push(node), getFloatTimeDomainData: samples => samples.fill(state.fill) };
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
    const meter = createMicLevelMeter({}, () => {}, { AudioContextClass: Context });
    expect(meter.supported).toBe(true);
    meter.stop();
    expect(state.connected).toEqual([state.analyser]);
  });

  it('reports nothing while the audio context is suspended, keeps asking it to resume, and reports once it runs', () => {
    const { state, Context } = fakeAudio(0, 'suspended');
    const levels = [];
    const meter = createMicLevelMeter({}, value => levels.push(value), { AudioContextClass: Context, intervalMs: 100 });
    expect(meter.supported).toBe(true);
    vi.advanceTimersByTime(6000);
    // Zeros from a suspended context would read as a dead microphone, so there must be no readings at all.
    expect(levels).toEqual([]);
    expect(state.resumed).toBeGreaterThan(1);
    state.contextState = 'running'; state.fill = 0.05;
    vi.advanceTimersByTime(100);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toBeGreaterThan(SILENCE_LEVEL);
    meter.stop();
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
