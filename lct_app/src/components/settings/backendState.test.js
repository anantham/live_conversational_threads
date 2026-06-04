import { describe, it, expect } from 'vitest';

import { runState, isServing } from './backendState';

const entry = (over = {}) => ({ status: 'available', runnable: true, ...over });

describe('runState', () => {
  it('not_running for planned / install_failed / runnable=false (regardless of probe)', () => {
    expect(runState(entry({ status: 'planned' }), { ok: true })).toBe('not_running');
    expect(runState(entry({ status: 'install_failed' }), null)).toBe('not_running');
    expect(runState(entry({ runnable: false }), { ok: true })).toBe('not_running');
  });

  it('running only when the probe is verified ok', () => {
    expect(runState(entry(), { ok: true, latency_ms: 5 })).toBe('running');
  });

  it('offline when probe ok === false', () => {
    expect(runState(entry(), { ok: false, error: 'down' })).toBe('offline');
  });

  it('unverifiable when probe ok === null (cloud / no health endpoint)', () => {
    expect(runState(entry(), { ok: null })).toBe('unverifiable');
  });

  it('checking while a probe is in flight', () => {
    expect(runState(entry(), { checking: true })).toBe('checking');
  });

  it('INVARIANT: selected + runnable + not-yet-probed is "checking", never "running"', () => {
    // The honesty rule: GREEN = probe-verified. Status alone must not go green.
    expect(runState(entry(), undefined)).toBe('checking');
    expect(runState(entry(), null)).toBe('checking');
  });
});

describe('isServing', () => {
  it('is false only for known-down states (offline / not_running)', () => {
    expect(isServing(entry(), { ok: false })).toBe(false);
    expect(isServing(entry({ status: 'planned' }), null)).toBe(false);
  });

  it('is true for serving-or-unknown states (no premature "serving elsewhere" banner)', () => {
    expect(isServing(entry(), { ok: true })).toBe(true); // running
    expect(isServing(entry(), { ok: null })).toBe(true); // unverifiable cloud
    expect(isServing(entry(), undefined)).toBe(true); // checking → unknown, don't claim down
  });
});
