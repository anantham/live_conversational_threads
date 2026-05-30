import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Mic, RefreshCw, Sparkles, Users } from 'lucide-react';

import CapabilityLane from './CapabilityLane';
import useBackendCatalog from './useBackendCatalog';
import { getSttSettings, updateSttSettings } from '../../services/sttSettingsApi';
import { getLlmSettings, updateLlmSettings } from '../../services/llmSettingsApi';
import { getDiarizationSettings, updateDiarizationSettings } from '../../services/backendCatalogApi';

function scrollToAdvanced() {
  const el = document.getElementById('advanced-settings');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The 3-lane "Inference runtime" hero of the Settings page. Reads the backend
 * catalog (benchmark seed + live telemetry + active config) and lets the user
 * independently pick the active backend per capability (STT / Diarization / LLM),
 * see model · where-it-runs · empirical speed/accuracy · cost, and live-probe each.
 * Deep fallback/endpoint/key editing stays in the Advanced cards below.
 */
export default function InferenceLanes() {
  const { catalog, loading, error, probes, refresh, probe } = useBackendCatalog();
  const [sttSettings, setSttSettings] = useState(null);
  const [llmSettings, setLlmSettings] = useState(null);
  const [diarSettings, setDiarSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const loadSettings = useCallback(async () => {
    const [stt, llm, diar] = await Promise.allSettled([
      getSttSettings(),
      getLlmSettings(),
      getDiarizationSettings(),
    ]);
    if (stt.status === 'fulfilled') setSttSettings(stt.value);
    if (llm.status === 'fulfilled') setLlmSettings(llm.value);
    if (diar.status === 'fulfilled') setDiarSettings(diar.value);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const afterSave = useCallback(
    async (message) => {
      setNotice({ kind: 'ok', text: message });
      await Promise.all([refresh(), loadSettings()]);
      setTimeout(() => setNotice(null), 3500);
    },
    [refresh, loadSettings],
  );

  const guarded = useCallback(
    async (fn, okMessage, noticeOverride) => {
      setBusy(true);
      setNotice(null);
      try {
        await fn();
        if (noticeOverride) {
          await Promise.all([refresh(), loadSettings()]);
          setNotice(noticeOverride);
          setTimeout(() => setNotice(null), 6000);
        } else {
          await afterSave(okMessage);
        }
      } catch (err) {
        setNotice({ kind: 'error', text: err.message || 'Update failed' });
      } finally {
        setBusy(false);
      }
    },
    [afterSave, refresh, loadSettings],
  );

  // ── per-capability "make primary" handlers (load → merge → save) ───────────

  const setSttPrimary = useCallback(
    (entry) => {
      // Whisper-family engines share provider_key 'whisper'. Without their own HTTP
      // endpoint, saving provider='whisper' silently resolves back to the default
      // local server — so don't fake the switch; point the user at Advanced.
      if (entry.provider_key === 'whisper' && !entry.endpoint) {
        setNotice({
          kind: 'warn',
          text: `${entry.display_name} needs its own HTTP endpoint first — set the whisper URL under Advanced → STT endpoints, then it can be the active engine.`,
        });
        setTimeout(() => setNotice(null), 7000);
        return undefined;
      }
      return guarded(async () => {
        const cur = sttSettings || (await getSttSettings());
        const next = { ...cur, provider: entry.provider_key };
        if (entry.provider_key === 'whisper' && entry.endpoint) {
          next.provider_http_urls = { ...(cur.provider_http_urls || {}), whisper: entry.endpoint };
          next.http_url = entry.endpoint;
        }
        await updateSttSettings(next);
      }, `STT set to ${entry.display_name}`);
    },
    [guarded, sttSettings],
  );

  const setLlmPrimary = useCallback(
    (entry) => {
      const isCloud = (entry.runtime || '').startsWith('cloud-');
      // Only Gemini is reachable via the online-mode switch (generate_lct_json
      // routes online→Gemini). Other cloud providers live in the Advanced provider
      // chain (need an API-key entry), so don't fake a switch that resolves to Gemini.
      if (isCloud && entry.id !== 'cloud-gemini') {
        setNotice({
          kind: 'warn',
          text: `${entry.display_name} is added under Advanced → Providers (with an API key); it then serves via the provider chain. The online-mode switch only routes to Gemini.`,
        });
        setTimeout(() => setNotice(null), 8000);
        return undefined;
      }
      const override =
        entry.id === 'cloud-gemini'
          ? { kind: 'warn', text: 'Switched to online (Gemini) mode — ensure a Gemini API key is set in Advanced.' }
          : undefined;
      return guarded(
        async () => {
          const cur = llmSettings || (await getLlmSettings());
          const next = { ...cur };
          if (entry.is_local && entry.endpoint) {
            next.mode = 'local';
            next.base_url = entry.endpoint;
          } else if (entry.id === 'cloud-gemini') {
            next.mode = 'online';
          }
          await updateLlmSettings(next);
        },
        `LLM set to ${entry.display_name}`,
        override,
      );
    },
    [guarded, llmSettings],
  );

  const setDiarPrimary = useCallback(
    (entry) => {
      const notRunning = entry.status === 'planned' || entry.runnable === false;
      const override = notRunning
        ? {
            kind: 'warn',
            text: `Selected ${entry.display_name}, but it isn't running yet${entry.start_hint ? ` — ${entry.start_hint}` : ''}. Another diarizer (or your STT provider) serves until then.`,
          }
        : undefined;
      return guarded(
        async () => {
          const cur = diarSettings || (await getDiarizationSettings());
          await updateDiarizationSettings({ ...cur, primary: entry.provider_key });
        },
        `Diarization set to ${entry.display_name}`,
        override,
      );
    },
    [guarded, diarSettings],
  );

  const moveDiarFallback = useCallback(
    (providerKey, direction) =>
      guarded(async () => {
        const cur = diarSettings || (await getDiarizationSettings());
        const order = Array.isArray(cur.fallback_priority) ? [...cur.fallback_priority] : [];
        const i = order.indexOf(providerKey);
        const j = i + direction;
        if (i < 0 || j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        await updateDiarizationSettings({ ...cur, fallback_priority: order });
      }, 'Diarization fallback order updated'),
    [guarded, diarSettings],
  );

  // Order diarization alternatives by the configured fallback_priority so the
  // reorder chevrons map to a meaningful list.
  const diarEntries = useMemo(() => {
    if (!catalog) return [];
    const entries = catalog.diarization || [];
    const order = diarSettings && Array.isArray(diarSettings.fallback_priority) ? diarSettings.fallback_priority : [];
    if (!order.length) return entries;
    const rank = (e) => {
      const idx = order.indexOf(e.provider_key);
      return idx < 0 ? order.length : idx;
    };
    return [...entries].sort((a, b) => rank(a) - rank(b));
  }, [catalog, diarSettings]);

  // If no separate diarizer runs, speaker labels may still come from the STT
  // provider itself (some whisper/cloud routes diarize) — say so instead of
  // claiming "nothing running".
  const diarNothingHint = useMemo(() => {
    if (!catalog) return undefined;
    const sttId = catalog.active && (catalog.active.stt_effective || catalog.active.stt);
    const sttEntry = (catalog.stt || []).find((e) => e.id === sttId);
    if (sttEntry && sttEntry.provides_diarization) {
      return `No separate diarizer is running — speaker labels come from your STT provider (${String(sttEntry.display_name).split(' (')[0]}).`;
    }
    return undefined;
  }, [catalog]);

  if (loading && !catalog) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading inference backends…
      </section>
    );
  }

  if (error && !catalog) {
    return (
      <section className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        Failed to load backend catalog: {error}
      </section>
    );
  }

  const active = catalog.active || {};
  const noticeCls =
    notice && notice.kind === 'error'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : notice && notice.kind === 'warn'
      ? 'bg-amber-50 text-amber-800 border-amber-200'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Inference runtime</h2>
          <p className="text-[12px] text-gray-500">
            Pick the active backend per capability. Numbers are empirical — benchmark seed, refined by your live usage.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </button>
      </div>

      {notice && <div className={`rounded-lg border px-3 py-2 text-[12px] ${noticeCls}`}>{notice.text}</div>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <CapabilityLane
          title="Speech-to-text"
          subtitle="Words from audio"
          icon={Mic}
          capability="stt"
          entries={catalog.stt || []}
          primaryId={active.stt}
          effectiveId={active.stt_effective}
          probes={probes}
          advancedLabel="Endpoints & fallback"
          onProbe={probe}
          onSetPrimary={setSttPrimary}
          onAdvanced={scrollToAdvanced}
        />
        <CapabilityLane
          title="Diarization"
          subtitle="Who spoke + voice ID"
          icon={Users}
          capability="diarization"
          entries={diarEntries}
          primaryId={active.diarization}
          effectiveId={active.diarization_effective}
          probes={probes}
          reorderable
          nothingRunningHint={diarNothingHint}
          advancedLabel="Speaker library"
          onProbe={probe}
          onSetPrimary={setDiarPrimary}
          onMove={moveDiarFallback}
          onAdvanced={scrollToAdvanced}
        />
        <CapabilityLane
          title="LLM intelligence"
          subtitle="Builds the graph"
          icon={Sparkles}
          capability="llm"
          entries={catalog.llm || []}
          primaryId={active.llm}
          effectiveId={active.llm_effective}
          probes={probes}
          advancedLabel="Providers & models"
          onProbe={probe}
          onSetPrimary={setLlmPrimary}
          onAdvanced={scrollToAdvanced}
        />
      </div>
    </section>
  );
}
