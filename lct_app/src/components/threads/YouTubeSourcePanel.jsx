import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { mediaOffsetLabel } from "../../services/mediaSeek";
import { nodeVideoPassages, selectYouTubeRef } from "../../services/youtubeMedia";

let apiPromise;
function loadPlayerApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timer;
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timer);
      resolve(window.YT);
    };
    const failed = () => { clearTimeout(timer); apiPromise = null; script.remove(); reject(new Error("YouTube could not load here. Open the passage on YouTube below.")); };
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = failed;
    timer = window.setTimeout(failed, 20000);
    document.head.appendChild(script);
  });
  return apiPromise;
}

export default function YouTubeSourcePanel({ bundle, node, nodes, compact = false, onRenameSpeaker }) {
  const media = selectYouTubeRef(bundle);
  const videoId = media?.video_id;
  const videoLabel = media?.label || "Conversation recording";
  const host = useRef(null);
  const player = useRef(null);
  const pending = useRef(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(null);
  const [speakerId, setSpeakerId] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const passages = useMemo(() => nodeVideoPassages(node, nodes, bundle.utterances || []), [node, nodes, bundle.utterances]);
  const first = passages[0]?.timestamp_start;
  const speakers = [...new Set((bundle.utterances || []).map((u) => u.speaker_id).filter((id) => id && id !== "UNKNOWN"))];

  useEffect(() => {
    if (first == null) { pending.current = null; setActive(null); return; }
    pending.current = first;
    setActive(first);
    // Seeking does not force playback. A reader can keep the video paused.
    player.current?.seekTo(first, true);
  }, [first, node?.id]);

  useEffect(() => {
    if (!enabled || !videoId) return undefined;
    let canceled = false;
    let instance;
    // YT replaces this child; React owns only the stable outer host.
    const child = document.createElement("div");
    host.current.replaceChildren(child);
    loadPlayerApi().then((YT) => {
      if (canceled) return;
      instance = new YT.Player(child, {
        width: "100%", height: "100%", videoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { playsinline: 1, origin: window.location.origin, rel: 0 },
        events: {
          onReady: () => {
            if (canceled) return;
            player.current = instance;
            instance.getIframe().title = videoLabel;
            if (pending.current != null) instance.seekTo(pending.current, true);
          },
          onError: () => setError("This video cannot play embedded here. Open the passage on YouTube below."),
        },
      });
    }).catch((e) => { if (!canceled) setError(e.message); });
    return () => { canceled = true; player.current = null; instance?.destroy(); };
  }, [enabled, videoId, videoLabel]);

  if (!media) return null;
  const seek = (seconds) => {
    pending.current = seconds;
    setActive(seconds);
    setEnabled(true);
    player.current?.seekTo(seconds, true);
  };
  const href = `${media.view_url}${active == null ? "" : `&t=${Math.floor(active)}s`}`;

  return (
    <aside aria-label="YouTube source" className={`shrink-0 border-slate-200 bg-white p-3 ${compact ? "max-h-[50dvh] overflow-y-auto border-b" : "w-[360px] max-w-[38vw] overflow-y-auto border-r"}`}>
      {!enabled ? (
        <button type="button" onClick={() => setEnabled(true)} className="w-full rounded-lg border border-slate-200 bg-stone-50 px-4 py-3 text-sm text-slate-700 hover:bg-amber-50">
          Watch the source conversation
          <span className="mt-1 block text-xs text-slate-400">Loads YouTube. Selecting a passage sets its position.</span>
        </button>
      ) : <div ref={host} className="min-h-[200px] w-full bg-stone-100" style={{ height: compact ? 200 : 210 }} />}
      {error && <p role="alert" className="mt-2 text-xs text-amber-800">{error}</p>}
      <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 block text-xs text-amber-700">
        {active == null ? "Open on YouTube" : `Open ${mediaOffsetLabel(active)} on YouTube`}
      </a>
      {!compact && <p className="mt-3 text-xs leading-5 text-slate-500">Select a node to find its source passages. Speaker labels and speech timings are machine estimates; overlapping speech may need review.</p>}
      {node && !passages.length && <p className="mt-2 text-xs text-slate-500">No timestamped source is bound to this node.</p>}
      {passages.length > 0 && (
        <div aria-label="Source passages" className={`mt-2 space-y-1 overflow-y-auto ${compact ? "max-h-20" : "max-h-64"}`}>
          {passages.map((u) => <button key={u.id} type="button" onClick={() => seek(u.timestamp_start)} className={`block w-full rounded px-2 py-2 text-left text-xs leading-5 ${active === u.timestamp_start ? "bg-amber-50" : "hover:bg-stone-50"}`}>
            <span className="text-amber-700">{mediaOffsetLabel(u.timestamp_start)}</span>{" · "}
            <span className="font-medium">{u.speaker_name || u.speaker_id || "Unknown"}</span>{" "}{u.text}
          </button>)}
        </div>
      )}
      {onRenameSpeaker && speakers.length > 0 && <details className="mt-3 text-xs text-slate-500">
        <summary className="cursor-pointer">Name the speakers</summary>
        <form className="mt-2 space-y-2" onSubmit={(e) => { e.preventDefault(); onRenameSpeaker(speakerId || speakers[0], speakerName); setSpeakerName(""); }}>
          <p>Edits stay in this browser. Download the reviewed file to share them.</p>
          <select aria-label="Speaker to name" value={speakerId || speakers[0]} onChange={(e) => setSpeakerId(e.target.value)} className="w-full rounded border p-2">{speakers.map((s) => <option key={s}>{s}</option>)}</select>
          <input aria-label="Speaker name" required maxLength={80} value={speakerName} onChange={(e) => setSpeakerName(e.target.value)} className="w-full rounded border p-2" />
          <button className="rounded border px-3 py-2" type="submit">Apply name</button>
        </form>
        <button type="button" className="mt-2 rounded border px-3 py-2" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url; link.download = "reviewed-conversation.threads";
          document.body.appendChild(link); link.click(); link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download reviewed .threads</button>
      </details>}
    </aside>
  );
}

YouTubeSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, node: PropTypes.object, nodes: PropTypes.array.isRequired, compact: PropTypes.bool, onRenameSpeaker: PropTypes.func };
