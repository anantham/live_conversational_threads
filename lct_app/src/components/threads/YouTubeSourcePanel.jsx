import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { mediaOffsetLabel } from "../../services/mediaSeek";
import { nodeVideoPassages, selectYouTubeRef, validYouTubeRef, validMediaSeconds } from "../../services/youtubeMedia";

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
  const passageList = useRef(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(null);
  const [speakerId, setSpeakerId] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const [transcriptHeight, setTranscriptHeight] = useState(compact ? 80 : 256);
  const passages = useMemo(() => nodeVideoPassages(node, nodes, bundle.utterances || []), [node, nodes, bundle.utterances]);
  const first = passages[0]?.timestamp_start;
  const playbackRows = useMemo(() => {
    const rows=(bundle.utterances || []).filter(u=>validMediaSeconds(u.timestamp_start))
      .sort((a,b)=>a.timestamp_start-b.timestamp_start);
    // Known ends preserve silence gaps. Start-only imports use the next start
    // as an approximate highlight boundary, never as measured speech duration.
    let nextStart=Infinity;
    const indexed=new Array(rows.length);
    for(let i=rows.length-1;i>=0;i--){
      const u=rows[i];
      if(i+1<rows.length && rows[i+1].timestamp_start>u.timestamp_start) nextStart=rows[i+1].timestamp_start;
      const end=validMediaSeconds(u.timestamp_end) ? u.timestamp_end
        : validMediaSeconds(u.duration_seconds ?? u.duration) ? u.timestamp_start+(u.duration_seconds ?? u.duration)
        : nextStart;
      indexed[i]={utterance:u,end};
    }
    return indexed;
  }, [bundle.utterances]);
  const playbackPassage = useMemo(() => {
    if(active==null) return null;
    for(let i=playbackRows.length-1;i>=0;i--){
      const {utterance,end}=playbackRows[i];
      if(utterance.timestamp_start<=active && active<end) return utterance;
    }
    return null;
  }, [active, playbackRows]);
  const outsideSelection = playbackPassage && !passages.some((u) => u.id === playbackPassage.id);
  useEffect(() => {
    const list = passageList.current;
    const row = list?.querySelector('[aria-current="true"]');
    if (!row) return;
    const bounds = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
      list.scrollTop += rect.top - bounds.top - (list.clientHeight - rect.height) / 2;
    }
  }, [playbackPassage?.id]);
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
    let clock;
    const readClock = () => {
      if (canceled || document.visibilityState === "hidden") return;
      const seconds = instance?.getCurrentTime?.();
      if (validMediaSeconds(seconds)) setActive(seconds);
    };
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
            // YouTube has no timeupdate event. Poll while enabled (including
            // paused seeks); observing the clock must never call seekTo.
            clock = window.setInterval(readClock, 250);
          },
          onStateChange: readClock,
          onError: () => setError("This video cannot play embedded here. Open the passage on YouTube below."),
        },
      });
    }).catch((e) => { if (!canceled) setError(e.message); });
    return () => { canceled = true; window.clearInterval(clock); player.current = null; instance?.destroy(); };
  }, [enabled, videoId, videoLabel]);

  if (!media) {
    const unsupported = (bundle.media_refs || []).some((ref) => ref?.provider === "youtube" && !validYouTubeRef(ref));
    return unsupported ? <aside role="status" className={`shrink-0 border-slate-200 bg-amber-50 p-3 text-xs text-slate-700 ${compact ? "border-b" : "w-[360px] max-w-[38vw] border-r"}`}>
      YouTube source unavailable: its video identity or time units could not be verified. The conversation remains readable; the original source metadata is preserved.
    </aside> : null;
  }
  const seek = (seconds) => {
    pending.current = seconds;
    setActive(seconds);
    setEnabled(true);
    player.current?.seekTo(seconds, true);
  };
  const href = `${media.view_url}${active == null ? "" : `&t=${Math.floor(active)}s`}`;

  return (
    <aside aria-label="YouTube source" className={`shrink-0 border-slate-200 bg-white p-2 ${compact ? "max-h-[60dvh] overflow-y-auto border-b" : "w-[360px] max-w-[38vw] overflow-y-auto border-r"}`}>
      <details open className="text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Video</summary>
      {!enabled ? (
        <button type="button" onClick={() => setEnabled(true)} className="w-full rounded-lg border border-slate-200 bg-stone-50 px-4 py-3 text-sm text-slate-700 hover:bg-amber-50">
          Watch the source conversation
          <span className="mt-1 block text-xs text-slate-400">Loads YouTube. Selecting a passage sets its position.</span>
        </button>
      ) : <div ref={host} className="min-h-[200px] w-full bg-stone-100" style={{ height: compact ? 200 : 210 }} />}
      {error && <p role="alert" className="mt-2 text-xs text-amber-800">{error}</p>}
      {error && <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 block text-xs text-amber-700">
        {active == null ? "Open on YouTube" : `Open ${mediaOffsetLabel(active)} on YouTube`}
      </a>}
      </details>
      <details open className="text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Transcript</summary>
      {!compact && <p className="mt-3 text-xs leading-5 text-slate-500">Select a node to find its source passages. Speaker labels and speech timings are machine estimates; overlapping speech may need review.</p>}
      {node && !passages.length && <p className="mt-2 text-xs text-slate-500">No timestamped source is bound to this node.</p>}
      {passages.length > 0 && (
        <div ref={passageList} aria-label="Source passages" className="mt-1 space-y-1 overflow-y-auto" style={{maxHeight: transcriptHeight}}>
          {passages.map((u) => <button key={u.id} type="button" aria-current={playbackPassage?.id === u.id ? "true" : undefined} onClick={() => seek(u.timestamp_start)} className={`block w-full rounded px-2 py-2 text-left text-xs leading-5 ${playbackPassage?.id === u.id ? "bg-amber-50" : "hover:bg-stone-50"}`}>
            <span className="text-amber-700">{mediaOffsetLabel(u.timestamp_start)}</span>{" · "}
            <span className="font-medium">{u.speaker_name || u.speaker_id || "Unknown"}</span>{" "}{u.text}
          </button>)}
        </div>
      )}
      {outsideSelection && <div className="mt-2 text-xs text-slate-500">
        Playing elsewhere in the conversation
        <button type="button" aria-current="true" onClick={() => seek(playbackPassage.timestamp_start)} className="mt-1 block w-full rounded bg-amber-50 p-2 text-left leading-5">
          {mediaOffsetLabel(playbackPassage.timestamp_start)} · {playbackPassage.speaker_name || playbackPassage.speaker_id || "Unknown"} · {playbackPassage.text}
        </button>
      </div>}
      {passages.length > 0 && <label className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
        Transcript height
        <input aria-label="Transcript height" type="range" min="48" max="360" step="8" value={transcriptHeight} onChange={(event) => setTranscriptHeight(Number(event.target.value))} className="min-w-0 flex-1 accent-amber-600" />
      </label>}
      </details>
      {onRenameSpeaker && speakers.length > 0 && <details className="mt-1 text-xs text-slate-500">
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
