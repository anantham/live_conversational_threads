// @vitest-environment jsdom
// Test intent: lct_app/tests/intent/publish-link.md. Synthetic data only.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublishLinkPanel from './PublishLinkPanel.jsx';

const bundle = { conversation_title: 'Garden', graph_data: [], edges: [], utterances: [{ id: 'u1', text: 'Hi.', speaker_id: 'Sam' }, { id: 'u2', text: 'Hello.', speaker_id: 'Alex' }],
  meeting_metadata: { invited_emails: ['a@example.com'], recording_url: 'https://drive.example/rec' } };
let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const buttonNamed = name => [...host.querySelectorAll('button')].find(b => b.textContent === name);
const labelWith = text => [...host.querySelectorAll('label')].find(l => l.textContent.includes(text));

describe('PublishLinkPanel', () => {
  it('needs explicit consent, leaves personal metadata out by default, then shows the link', async () => {
    const publish = vi.fn(async () => ({ url: 'https://site.example/public/abc', capability: { id: 'abc', key: 'k' } }));
    act(() => root.render(<PublishLinkPanel bundle={bundle} publish={publish} />));
    expect(host.textContent).toMatch(/2 turns, the words of Sam, Alex/);
    expect(labelWith('Also include').textContent).toMatch(/1 attendee email, 1 recording\/doc\/calendar link/);
    expect(labelWith('Also include').querySelector('input').checked).toBe(false);
    expect(buttonNamed('Publish & copy link').disabled).toBe(true);
    act(() => labelWith('I have permission').querySelector('input').click());
    await act(async () => { buttonNamed('Publish & copy link').click(); });
    expect(publish).toHaveBeenCalledWith(bundle, { includePersonal: false, visibility: 'unlisted' });
    expect(host.querySelector('input[aria-label="Shareable link"]').value).toBe('https://site.example/public/abc');
    expect(host.textContent).toMatch(/not listed in the public library/);
  });

  it('publishes once on a double click, and a changed map needs fresh consent', async () => {
    let release;
    const publish = vi.fn(() => new Promise(resolve => { release = resolve; }));
    act(() => root.render(<PublishLinkPanel bundle={bundle} publish={publish} />));
    act(() => labelWith('I have permission').querySelector('input').click());
    await act(async () => { buttonNamed('Publish & copy link').click(); buttonNamed('Publishing…')?.click(); });
    expect(publish).toHaveBeenCalledTimes(1);
    await act(async () => { release({ url: 'https://site.example/public/one', capability: { id: 'one', key: 'k' } }); });
    act(() => buttonNamed('Publish the current map as a new link').click());
    act(() => root.render(<PublishLinkPanel bundle={{ ...bundle, conversation_title: 'Changed' }} publish={publish} />));
    expect(labelWith('I have permission').querySelector('input').checked).toBe(false);
  });

  it('offers the removal key when the outcome of a send is uncertain', async () => {
    const publish = vi.fn(async () => { throw Object.assign(new Error('network dropped'), { uncertain: true, capability: { id: 'x', key: 'k' }, url: 'https://site.example/public/x' }); });
    act(() => root.render(<PublishLinkPanel bundle={bundle} publish={publish} />));
    act(() => labelWith('I have permission').querySelector('input').click());
    await act(async () => { buttonNamed('Publish & copy link').click(); });
    expect(host.textContent).toMatch(/may have been stored/);
    expect(buttonNamed('Download removal key')).toBeDefined();
  });
});

