// Test intent: lct_app/tests/intent/publish-link.md
import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Link2 } from 'lucide-react';
import { PUBLIC_MAX_BYTES, downloadRemovalKey, personalMetadataSummary, publicSafeCopy, publishBundle } from '../../services/publicThreads.js';

const button = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';
const kib = bytes => `${Math.ceil(bytes / 1024).toLocaleString('en-US')} KiB`;

/** One-step unlisted publication of a finished map, public-safe by default, with an explicit consent. */
export default function PublishLinkPanel({ bundle, publish = publishBundle }) {
  const [includePersonal, setIncludePersonal] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const personal = useMemo(() => personalMetadataSummary(bundle), [bundle]);
  const size = useMemo(() => new TextEncoder().encode(JSON.stringify(includePersonal ? bundle : publicSafeCopy(bundle))).byteLength, [bundle, includePersonal]);
  const speakers = useMemo(() => [...new Set((bundle.utterances || []).map(u => u.speaker_id).filter(Boolean))], [bundle]);
  const tooLarge = size > PUBLIC_MAX_BYTES;
  const hasPersonal = personal.emails || personal.links || personal.notes;

  async function start() {
    setBusy(true); setError('');
    try {
      const published = await publish(bundle, { includePersonal, visibility: 'unlisted' });
      setResult(published);
      // Some browsers refuse clipboard writes this long after the click; the Copy button remains.
      try { await navigator.clipboard.writeText(published.url); setCopied(true); } catch { setCopied(false); }
    }
    catch (cause) { setError(cause?.message || 'Publishing did not finish. Nothing was linked.'); }
    finally { setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(result.url); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <section aria-label="Publish a link" className="space-y-3 border-t border-slate-200 pt-4">
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
        <Link2 size={13} aria-hidden="true" /> Share with a link
      </p>
      {result ? (
        <div className="space-y-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          <p>Published as an unlisted link. Anyone with it can open and download this map; it is not listed in the public library.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input readOnly value={result.url} aria-label="Shareable link" className="min-w-0 flex-1 rounded-md border border-emerald-300 bg-white px-2 py-1 text-xs" />
            <button type="button" className={button} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" className={button} onClick={() => downloadRemovalKey(result.capability)}>Download removal key</button>
          </div>
          <p className="text-xs">The removal key is saved in this browser; download it too. It is the only way to take this link down.</p>
        </div>
      ) : (
        <>
          <p className="text-sm leading-6 text-slate-600">
            Publishes the map and its full transcript ({(bundle.utterances || []).length.toLocaleString('en-US')} turns, the words of {speakers.length ? speakers.join(', ') : 'every speaker'}) as an unlisted link. {kib(size)} of {kib(PUBLIC_MAX_BYTES)} allowed.
          </p>
          {hasPersonal ? (
            <label className="flex items-start gap-3 text-sm leading-6">
              <input type="checkbox" className="mt-1" checked={includePersonal} disabled={busy} onChange={event => setIncludePersonal(event.target.checked)} />
              Also include {[personal.emails ? `${personal.emails} attendee email${personal.emails === 1 ? '' : 's'}` : '', personal.links ? `${personal.links} recording/doc/calendar link${personal.links === 1 ? '' : 's'}` : '', personal.notes ? "Gemini's meeting notes" : ''].filter(Boolean).join(', ')} (left out by default).
            </label>
          ) : null}
          <label className="flex items-start gap-3 text-sm leading-6">
            <input type="checkbox" className="mt-1" checked={consent} disabled={busy || tooLarge} onChange={event => setConsent(event.target.checked)} />
            I have permission to publish everyone&apos;s words in this conversation. Anyone with the link can read and download it.
          </label>
          {tooLarge && <p role="alert" className="text-sm text-rose-800">This map is larger than the public limit; it cannot be published as is.</p>}
          <button type="button" className={primary} disabled={!consent || busy || tooLarge} onClick={() => void start()}>
            {busy ? 'Publishing…' : 'Publish & copy link'}
          </button>
        </>
      )}
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    </section>
  );
}
PublishLinkPanel.propTypes = { bundle: PropTypes.object.isRequired, publish: PropTypes.func };
