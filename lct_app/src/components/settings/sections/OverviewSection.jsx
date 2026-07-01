import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, ChevronRight, Info } from "lucide-react";

import InferenceLanes from "../InferenceLanes";
import ConnectionMeter from "../ConnectionMeter";
import { isServing } from "../backendState";
import useBackendCatalog from "../useBackendCatalog";
import { getSttSettings } from "../../../services/sttSettingsApi";
import { getLlmSettings } from "../../../services/llmSettingsApi";

function shortName(entry) {
  if (!entry) return "—";
  return String(entry.display_name || entry.id || "—").split(" (")[0];
}

function PostureRow({ serving, name, tag, posture, postureTone }) {
  const toneCls =
    postureTone === "priv"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : postureTone === "cloud"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-gray-100 bg-gray-50 text-gray-600";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3.5 py-3">
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${serving ? "bg-emerald-500" : "bg-gray-300"}`}
        aria-hidden="true"
      />
      <span className="font-semibold text-gray-900">{name}</span>
      {tag ? (
        <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{tag}</span>
      ) : null}
      {posture ? (
        <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11px] ${toneCls}`}>
          {posture}
        </span>
      ) : null}
    </div>
  );
}

PostureRow.propTypes = {
  serving: PropTypes.bool,
  name: PropTypes.string,
  tag: PropTypes.string,
  posture: PropTypes.string,
  postureTone: PropTypes.string,
};

export default function OverviewSection({ isServerless = false, onEdit }) {
  // Serverless / public visitor: no backend to glance at. Point them at Cloud.
  if (isServerless) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Now</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          You&apos;re using this app without a personal backend. Everything runs in your browser
          with the key you provide under Cloud &amp; sharing. Nothing goes to anyone&apos;s server
          except the AI provider you pick.
        </p>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span>
            No backend connected. Add an OpenAI key in{" "}
            <button
              type="button"
              onClick={() => onEdit?.("cloud")}
              className="font-medium text-gray-900 underline underline-offset-2"
            >
              Cloud &amp; sharing
            </button>{" "}
            to start recording and building graphs.
          </span>
        </div>
      </section>
    );
  }

  return <BackendOverview onEdit={onEdit} />;
}

OverviewSection.propTypes = {
  isServerless: PropTypes.bool,
  onEdit: PropTypes.func,
};

function BackendOverview({ onEdit }) {
  const { catalog } = useBackendCatalog();
  const [stt, setStt] = useState(null);
  const [llm, setLlm] = useState(null);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSttSettings().then((v) => !cancelled && setStt(v)).catch(() => {});
    getLlmSettings().then((v) => !cancelled && setLlm(v)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const active = catalog?.active || {};
    const sttEntry = (catalog?.stt || []).find((e) => e.id === (active.stt_effective || active.stt));
    const llmEntry = (catalog?.llm || []).find((e) => e.id === (active.llm_effective || active.llm));
    const diarEntry = (catalog?.diarization || []).find((e) => e.id === active.diarization_effective);

    const sttPosture = stt?.local_only
      ? "local-only"
      : stt?.store_audio
      ? "audio: stored"
      : "audio: not stored";

    // Speaker labels are "serving" only if a real diarizer is effective OR the
    // active STT engine itself provides diarization (provides_diarization). An
    // STT engine that can't diarize means no speaker labels, not "from STT".
    const sttProvidesDiar = Boolean(sttEntry?.provides_diarization);
    const speakerServing = diarEntry ? isServing(diarEntry, undefined) : sttProvidesDiar;
    const speakerName = diarEntry
      ? shortName(diarEntry)
      : sttProvidesDiar
      ? `from ${shortName(sttEntry)}`
      : "none running";

    const llmOnline = (llm?.mode || "local") === "online";

    return [
      {
        key: "stt",
        serving: sttEntry ? isServing(sttEntry, undefined) : false,
        name: shortName(sttEntry),
        tag: sttEntry?.runtime_label || sttEntry?.runtime,
        posture: sttPosture,
        postureTone: stt?.local_only ? "priv" : "neutral",
      },
      {
        key: "diar",
        serving: Boolean(speakerServing),
        name: "Speaker labels",
        tag: speakerName,
        posture: diarEntry?.emits_embeddings ? "voice-ID on" : "voice-ID off",
        postureTone: "neutral",
      },
      {
        key: "llm",
        serving: llmEntry ? isServing(llmEntry, undefined) : false,
        name: shortName(llmEntry),
        tag: llmEntry?.runtime_label || llmEntry?.runtime,
        posture: llmOnline ? "LLM: online (Gemini)" : "LLM: local · private",
        postureTone: llmOnline ? "cloud" : "priv",
      },
    ];
  }, [catalog, stt, llm]);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Now</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            What&apos;s running, where your data is going, and how solid the link is. Everything
            else is one click deeper.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2.5">
        {rows.map((r) => (
          <PostureRow key={r.key} {...r} />
        ))}
      </div>

      <ConnectionMeter enabled label="M5 backend" />

      <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
        <button
          type="button"
          onClick={() => setShowDetail((v) => !v)}
          aria-expanded={showDetail}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          <span>Failover order &amp; live detail</span>
          <span className="flex items-center gap-1 text-xs font-normal text-gray-400">
            {showDetail ? "hide" : "tap to expand"}
            {showDetail ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        </button>
        {showDetail ? (
          <div className="border-t border-gray-100 p-4">
            <InferenceLanes onAdvanced={(cap) => onEdit?.(cap === "diarization" ? "diar" : cap)} />
            <p className="mt-3 text-xs text-gray-400">
              Editing keys and endpoints lives one level deeper, inside each capability section.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

BackendOverview.propTypes = {
  onEdit: PropTypes.func,
};
