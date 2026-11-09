// Intent: tests/intent/local-conversation-retention.md. Injected disposable persistence; synthetic content only.
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationArchive } from './conversationArchive.js';
import { getConversationRetention, setConversationRetention } from './conversationRetention.js';
const recording = { id: 'synthetic-local-recording', startedAt: 1, transcribe: true };
const chunk = index => ({ segment: 1, index, blob: new Blob([`synthetic-${index}`]), mimeType: 'audio/webm' });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
it('defaults to device saving, remembers ephemeral only as a preference and never writes conversation content in ephemeral mode', async () => {
  expect(getConversationRetention()).toBe('local'); setConversationRetention('ephemeral'); expect(getConversationRetention()).toBe('ephemeral');
  const write = vi.fn(), states = [];
  const archive = new ConversationArchive(recording, { mode: 'ephemeral', write, onStatus: s => states.push(s.state) });
  archive.append(chunk(0)); archive.update({ transcript: { finalText: 'Private synthetic words', finalTokens: [{ text: 'Private synthetic words' }] }, map: { conversation_title: 'Private synthetic map' } });
  await archive.flush({ retry: true });
  expect(write).not.toHaveBeenCalled(); expect(states.every(s => s === 'ephemeral')).toBe(true);
  expect(JSON.stringify(localStorage)).not.toContain('Private synthetic');
});
it('announces saved only after durable acknowledgement and retains newer audio and map across an in-flight write', async () => {
  const rows = [], states = []; let finish;
  const write = vi.fn((record, audio) => new Promise(resolve => { finish = () => { rows.push({ record, audio }); resolve(); }; }));
  const archive = new ConversationArchive(recording, { write, onStatus: s => states.push(s.state) });
  archive.append(chunk(0)); const pending = archive.flush();
  expect(states).not.toContain('saved');
  archive.append(chunk(1)); archive.update({ map: { conversation_title: 'Latest map' }, stage: 'stopped' });
  finish(); await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(states).not.toContain('saved'); finish(); await pending;
  expect(rows.flatMap(r => r.audio).map(c => c.index)).toEqual([0, 1]);
  expect(rows.at(-1).record.map.conversation_title).toBe('Latest map'); expect(states.at(-1)).toBe('saved');
});
it('quota/aborted persistence never claims success, stops automatic retries and preserves all data for deliberate retry', async () => {
  vi.useFakeTimers(); const states = [], rows = [];
  const write = vi.fn().mockRejectedValueOnce(new DOMException('No space', 'QuotaExceededError')).mockImplementation(async (record, chunks) => rows.push({ record, chunks }));
  const archive = new ConversationArchive(recording, { write, onStatus: s => states.push(s.state) });
  archive.append(chunk(0)); await archive.flush(); expect(states.at(-1)).toBe('error');
  archive.append(chunk(1)); archive.update({ transcript: { finalText: 'Newest words', finalTokens: [{ text: 'Newest words' }] } });
  await vi.advanceTimersByTimeAsync(1000); expect(write).toHaveBeenCalledTimes(1); expect(states).not.toContain('saved');
  await archive.flush({ retry: true }); expect(rows[0].chunks.map(c => c.index)).toEqual([0, 1]); expect(rows[0].record.transcript.finalText).toBe('Newest words'); expect(states.at(-1)).toBe('saved');
});
it('separate conversations never replace one another and snapshots retain transcript, map and completion metadata', async () => {
  const records = new Map(), audio = new Map();
  const write = async (record, chunks) => { records.set(record.id, record); chunks.forEach(c => audio.set(`${c.recordingId}:${c.segment}:${c.index}`, c)); };
  const a = new ConversationArchive(recording, { write }); a.append(chunk(0));
  a.update({ transcript: { finalText: 'Garden plan', finalTokens: [{ text: 'Garden plan', startMs: 10, endMs: 20, speaker: '1' }] }, map: { conversation_title: 'Garden', graph_data: [{ id: 'a' }] }, segments: [{ number: 1, complete: true, bytes: 11, mimeType: 'audio/webm' }], stage: 'stopped' });
  await a.flush(); const b = new ConversationArchive({ ...recording, id: 'synthetic-next' }, { write }); b.append(chunk(0)); await b.flush();
  expect(records.size).toBe(2); expect(audio.size).toBe(2); expect(records.get(recording.id)).toMatchObject({ stage: 'stopped', title: 'Garden', segments: [{ number: 1, complete: true, bytes: 11, mimeType: 'audio/webm' }] });
  expect(records.get(recording.id).transcript.finalTokens[0].startMs).toBe(10);
});

it('opening an existing archive is read-only until an explicit content change', async () => {
  const write = vi.fn(async () => {}), initial = { id: recording.id, recording, transcript: { finalText: 'Saved words' }, map: null, updatedAt: 100 };
  const archive = new ConversationArchive(recording, { initial, write }); await archive.flush(); expect(write).not.toHaveBeenCalled();
  archive.update({ map: { conversation_title: 'A deliberate new map' } }); await archive.flush();
  expect(write.mock.lastCall[0].transcript.finalText).toBe('Saved words'); expect(write.mock.lastCall[1]).toEqual([]);
});

it('does not create an empty library entry for a denied or cancelled start', async () => {
  const write = vi.fn(), states = [];
  const archive = new ConversationArchive(recording, { write, onStatus: s => states.push(s.state) });
  archive.update({ stage: 'microphone' }); archive.update({ stage: 'cancelled' }); await archive.flush();
  expect(write).not.toHaveBeenCalled(); expect(states).not.toContain('saved');
});
it('uses revision acknowledgements and surfaces conflict without discarding uncommitted audio', async () => {
  const states = []; const write = vi.fn().mockResolvedValueOnce('revision-1').mockRejectedValueOnce(Object.assign(new Error('Newer copy in another tab'), { code: 'archive_conflict' }));
  const archive = new ConversationArchive(recording, { write, onStatus: s => states.push(s) }); archive.append(chunk(0)); await archive.flush();
  expect(write.mock.calls[0][2]).toBe(null); archive.append(chunk(1)); await archive.flush();
  expect(write.mock.calls[1][2]).toBe('revision-1'); expect(states.at(-1)).toMatchObject({ state: 'error', message: 'Newer copy in another tab' });
  write.mockResolvedValueOnce('revision-2'); await archive.flush({ retry: true }); expect(write.mock.lastCall[1].map(c => c.index)).toEqual([1]);
});
