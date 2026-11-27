// Test intent:
// - The canvas pill states the live map's schedule, ticks its countdown, and its single action either runs a map
//   or opens the map panel.
// - The microphone bar reflects real input level, flags an input that has gone quiet, and releases its meter.
// - A speaker label in the live transcript can be renamed in place with keyboard or pointer; one name relabels
//   every turn from that speaker, Escape discards, and a name being typed is not scrolled away by new words.
// Synthetic text and a fake meter only; no microphone is opened.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveMapHeartbeat from './LiveMapHeartbeat.jsx';
import MicLevelMeter from './MicLevelMeter.jsx';
import ConversationTranscriptPanel from './ConversationTranscriptPanel.jsx';
import { SILENCE_LEVEL } from '../../services/cloud/micLevelMeter.js';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const render = async element => { await act(async () => root.render(element)); };
const button = name => [...container.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || element.textContent) === name);
function type(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('live map heartbeat pill', () => {
  const mapped = 'Hello there. ';
  const tail = 'We follow one more thread about a synthetic community garden and the reading group that meets beside it every week in spring.';
  const schedule = overrides => ({ state: 'scheduled', canMapNow: true, complete: false, lastAttemptAt: 0, mappedChars: mapped.length,
    intervalMs: 25_000, minNewChars: 120, attemptsUsed: 1, maxAttempts: 20, ...overrides });

  it('counts down each second and runs a map from its one button', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onMapNow = vi.fn(), onOpenMap = vi.fn();
    await render(<LiveMapHeartbeat schedule={schedule({ lastAttemptAt: 1_000_000 - 11_000 })} finalText={mapped + tail} onMapNow={onMapNow} onOpenMap={onOpenMap} />);
    expect(container.textContent).toContain('Next map in 14 s · 22 new words');
    await act(async () => vi.advanceTimersByTime(3000));
    expect(container.textContent).toContain('Next map in 11 s · 22 new words');
    await act(async () => button('Map now').click());
    expect(onMapNow).toHaveBeenCalledTimes(1); expect(onOpenMap).not.toHaveBeenCalled();
  });

  it('announces only that the map is updating, never the per-second countdown', async () => {
    await render(<LiveMapHeartbeat schedule={schedule({ lastAttemptAt: Date.now() })} finalText={mapped + tail} onMapNow={() => {}} onOpenMap={() => {}} />);
    expect(container.querySelector('[role=status]').textContent).toBe('');
    await render(<LiveMapHeartbeat schedule={schedule({ state: 'mapping', canMapNow: false })} finalText={mapped + tail} onMapNow={() => {}} onOpenMap={() => {}} />);
    expect(container.querySelector('[role=status]').textContent).toBe('Updating the map.');
    expect(container.textContent).toContain('Mapping…');
    expect(container.querySelector('button')).toBeNull();
  });

  it('opens the map panel when the map cannot run from the canvas', async () => {
    const onMapNow = vi.fn(), onOpenMap = vi.fn();
    await render(<LiveMapHeartbeat schedule={schedule({ state: 'needs-consent', canMapNow: false })} finalText={mapped} onMapNow={onMapNow} onOpenMap={onOpenMap} />);
    expect(container.textContent).toContain('Live map is off');
    await act(async () => button('Set up').click());
    expect(onOpenMap).toHaveBeenCalledTimes(1); expect(onMapNow).not.toHaveBeenCalled();
  });

  it('renders nothing until a schedule exists', async () => {
    await render(<LiveMapHeartbeat schedule={null} finalText="" onMapNow={() => {}} onOpenMap={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('microphone level bar', () => {
  function fakeMeter() {
    const meter = { emit: null, stopped: 0, streams: [] };
    meter.create = (stream, onLevel) => { meter.streams.push(stream); meter.emit = onLevel; return { supported: true, stop: () => { meter.stopped += 1; } }; };
    return meter;
  }
  const bar = () => container.querySelector('[data-testid=mic-level]');

  it('shows nothing without an open microphone', async () => {
    const meter = fakeMeter();
    await render(<MicLevelMeter stream={null} createMeter={meter.create} />);
    expect(bar()).toBeNull(); expect(meter.streams).toHaveLength(0);
  });

  it('fills with the input level', async () => {
    const meter = fakeMeter(), stream = { id: 'synthetic' };
    await render(<MicLevelMeter stream={stream} createMeter={meter.create} />);
    expect(meter.streams).toEqual([stream]);
    await act(async () => meter.emit(0.62));
    expect(bar().firstChild.style.width).toBe('62%');
    expect(bar().dataset.silent).toBeUndefined();
  });

  it('flags an input that stays quiet, and clears the flag when sound returns', async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const meter = fakeMeter(), onSilentChange = vi.fn();
    await render(<MicLevelMeter stream={{}} createMeter={meter.create} onSilentChange={onSilentChange} silentAfterMs={5000} />);
    await act(async () => { vi.setSystemTime(5_004_000); meter.emit(SILENCE_LEVEL / 2); });
    expect(bar().dataset.silent).toBeUndefined();
    await act(async () => { vi.setSystemTime(5_005_100); meter.emit(SILENCE_LEVEL / 2); });
    expect(bar().dataset.silent).toBe('true');
    expect(onSilentChange).toHaveBeenLastCalledWith(true);
    await act(async () => { vi.setSystemTime(5_005_200); meter.emit(0.5); });
    expect(bar().dataset.silent).toBeUndefined();
    expect(onSilentChange).toHaveBeenLastCalledWith(false);
  });

  it('releases the meter when the microphone closes and reports no silence afterwards', async () => {
    const meter = fakeMeter(), onSilentChange = vi.fn();
    await render(<MicLevelMeter stream={{}} createMeter={meter.create} onSilentChange={onSilentChange} />);
    await render(<MicLevelMeter stream={null} createMeter={meter.create} onSilentChange={onSilentChange} />);
    expect(meter.stopped).toBe(1); expect(bar()).toBeNull();
    expect(onSilentChange).toHaveBeenLastCalledWith(false);
  });

  it('stays out of the way where the browser cannot measure audio', async () => {
    await render(<MicLevelMeter stream={{}} createMeter={() => ({ supported: false, stop() {} })} />);
    expect(bar()).toBeNull();
  });
});

describe('renaming a speaker in the live transcript', () => {
  const transcript = { finalText: 'Hello there. Again. Back to me.', partialText: '', partialTokens: [], finalTokens: [
    { text: 'Hello there.', speaker: '1', startMs: 0, endMs: 900 },
    { text: ' Again.', speaker: '2', startMs: 1000, endMs: 1500 },
    { text: ' Back to me.', speaker: '1', startMs: 1600, endMs: 2400 },
  ] };
  const panel = props => <ConversationTranscriptPanel transcript={transcript} status="Live" minimized={false} onMinimize={() => {}} fullscreen={false} onFullscreen={() => {}} {...props} />;
  const labels = () => [...container.querySelectorAll('[aria-label="Transcript history"] p > button, [aria-label="Transcript history"] p > span')].map(element => element.textContent);

  it('keeps plain labels when renaming is not offered', async () => {
    await render(panel());
    expect(labels()).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
    expect(container.querySelector('[aria-label="Transcript history"] button')).toBeNull();
  });

  it('saves a typed name with Enter and returns focus to the label', async () => {
    const onRenameSpeaker = vi.fn();
    await render(panel({ speakerNames: {}, onRenameSpeaker }));
    await act(async () => button('Rename Speaker 1').click());
    const input = container.querySelector('input[aria-label="Name for Speaker 1"]');
    expect(document.activeElement).toBe(input);
    await act(async () => type(input, '  Aditya  '));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(onRenameSpeaker).toHaveBeenCalledTimes(1);
    expect(onRenameSpeaker).toHaveBeenCalledWith('1', 'Aditya');
    expect(container.querySelector('input')).toBeNull();
    expect(document.activeElement.getAttribute('aria-label')).toBe('Rename Speaker 1');
  });

  it('shows one name on every turn from that speaker and leaves other speakers alone', async () => {
    await render(panel({ speakerNames: { 1: 'Aditya' }, onRenameSpeaker: () => {} }));
    expect(labels()).toEqual(['Aditya', 'Speaker 2', 'Aditya']);
    await act(async () => button('Rename Aditya').click());
    expect(container.querySelector('input').value).toBe('Aditya');
  });

  it('discards the edit on Escape without closing anything around it', async () => {
    const onRenameSpeaker = vi.fn(), outer = vi.fn();
    await render(<div onKeyDown={outer}>{panel({ speakerNames: {}, onRenameSpeaker })}</div>);
    await act(async () => button('Rename Speaker 2').click());
    const input = container.querySelector('input');
    await act(async () => type(input, 'Andre'));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(onRenameSpeaker).not.toHaveBeenCalled(); expect(outer).not.toHaveBeenCalled();
    expect(labels()).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
  });

  it('saves on blur, ignores an empty or unchanged name, and saves only once', async () => {
    const onRenameSpeaker = vi.fn();
    await render(panel({ speakerNames: { 2: 'Andre' }, onRenameSpeaker }));
    await act(async () => button('Rename Speaker 1').click());
    await act(async () => container.querySelector('input').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    await act(async () => button('Rename Andre').click());
    await act(async () => container.querySelector('input').dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(onRenameSpeaker).not.toHaveBeenCalled();
    await act(async () => button('Rename Speaker 1').click());
    const input = container.querySelector('input');
    await act(async () => type(input, 'Aditya'));
    // Enter and the blur it causes land before React renders again.
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onRenameSpeaker).toHaveBeenCalledTimes(1);
    expect(container.querySelector('p form')).toBeNull();
  });

  it('explains the rename while a name is being typed and stops following new words until it ends', async () => {
    await render(panel({ speakerNames: {}, onRenameSpeaker: () => {} }));
    const history = container.querySelector('[aria-label="Transcript history"]');
    Object.defineProperty(history, 'scrollHeight', { configurable: true, get: () => 900 });
    const hint = container.querySelector('#speaker-rename-hint');
    expect(hint.className).toBe('sr-only');
    await act(async () => button('Rename Speaker 1').click());
    expect(hint.className).not.toContain('sr-only');
    expect(hint.textContent).toContain('every turn');
    history.scrollTop = 0;
    const longer = { ...transcript, finalTokens: [...transcript.finalTokens, { text: ' More words.', speaker: '2', startMs: 2500, endMs: 3000 }] };
    await render(panel({ transcript: longer, speakerNames: {}, onRenameSpeaker: () => {} }));
    expect(history.scrollTop).toBe(0);
    expect(container.querySelector('input')).toBeTruthy();
    await act(async () => container.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await render(panel({ transcript: { ...longer, finalText: `${longer.finalText} x` }, speakerNames: {}, onRenameSpeaker: () => {} }));
    expect(history.scrollTop).toBe(900);
  });
});
