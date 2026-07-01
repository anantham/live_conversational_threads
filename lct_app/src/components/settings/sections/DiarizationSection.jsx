import { useCallback, useEffect, useMemo, useState } from "react";

import RankedEngineList from "../RankedEngineList";
import SpeakerVoiceLibraryCard from "../SpeakerVoiceLibraryCard";
import useBackendCatalog from "../useBackendCatalog";
import {
  getDiarizationSettings,
  updateDiarizationSettings,
} from "../../../services/backendCatalogApi";

// Diarization is the capability whose data model fits the unified ranked list:
// both `primary` and `fallback_priority` are engine provider_keys, so one list
// (top = primary, rest = fallback order) maps directly onto the settings write.
// Reordering keys row 0 as primary and the remainder as the fallback order,
// mirroring the separate make-primary / reorder-fallback operations the
// Active-engines lane used to perform.
export default function DiarizationSection() {
  const { catalog, refresh } = useBackendCatalog();
  const [diar, setDiar] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getDiarizationSettings()
      .then((v) => !cancelled && setDiar(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => {
    const entries = catalog?.diarization || [];
    const primary = diar?.primary;
    const fb = Array.isArray(diar?.fallback_priority) ? diar.fallback_priority : [];
    const orderKeys = [primary, ...fb].filter(Boolean);
    const rank = (e) => {
      const i = orderKeys.indexOf(e.provider_key);
      return i < 0 ? orderKeys.length + 1 : i;
    };
    return [...entries]
      .sort((a, b) => rank(a) - rank(b))
      .map((e) => {
        const down = e.status === "planned" || e.runnable === false;
        return {
          id: e.provider_key,
          name: String(e.display_name || e.provider_key).split(" (")[0],
          tag: e.runtime_label || e.runtime,
          meta: e.emits_embeddings ? "voice-ID" : "labels only",
          status: down ? "idle" : "ok",
          disabled: down,
          disabledReason: down
            ? e.start_hint
              ? `Not running yet — ${e.start_hint}`
              : "Not running yet"
            : undefined,
        };
      });
  }, [catalog, diar]);

  const downIds = useMemo(
    () => new Set(items.filter((it) => it.disabled).map((it) => it.id)),
    [items],
  );

  const onReorder = useCallback(
    async (order) => {
      if (busy) return; // serialize: ignore reorders while a save is in flight
      setBusy(true);
      setNotice(null);
      const prevDiar = diar;
      // optimistic: show the new order immediately, roll back on failure
      setDiar((cur) => ({
        ...(cur || {}),
        primary: order[0],
        fallback_priority: order.slice(1),
      }));
      try {
        const cur = prevDiar || (await getDiarizationSettings());
        const updated = await updateDiarizationSettings({
          ...cur,
          primary: order[0],
          fallback_priority: order.slice(1),
        });
        setDiar(updated);
        await refresh();
        if (downIds.has(order[0])) {
          setNotice({
            kind: "warn",
            text: `Saved, but ${order[0]} isn't running yet — another diarizer (or your STT engine) serves until it starts.`,
          });
          setTimeout(() => setNotice(null), 6000);
        } else {
          setNotice({ kind: "ok", text: `Diarizer order saved (primary: ${order[0]}).` });
          setTimeout(() => setNotice(null), 3000);
        }
      } catch (err) {
        setDiar(prevDiar); // roll back the optimistic update
        setNotice({ kind: "error", text: err.message || "Update failed" });
      } finally {
        setBusy(false);
      }
    },
    [busy, diar, downIds, refresh],
  );

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900">Diarizer</h3>
        <p className="mb-3 mt-1 max-w-2xl text-xs text-gray-600">
          Who spoke, and voice identification. The top engine runs first; the rest are the fallback
          order. Drag, or use the arrows, to reorder.
        </p>
        {notice ? (
          <div
            className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
              notice.kind === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : notice.kind === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {notice.text}
          </div>
        ) : null}
        {diar && items.length ? (
          <div className={busy ? "pointer-events-none opacity-60" : ""}>
            <RankedEngineList items={items} onReorder={onReorder} />
          </div>
        ) : (
          <p className="text-sm text-gray-500">Loading diarizers…</p>
        )}
        {busy ? <p className="mt-2 text-xs text-gray-400">Saving…</p> : null}
      </section>
      <SpeakerVoiceLibraryCard />
    </div>
  );
}
