import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import PanelResizeHandle from "../PanelResizeHandle";
import { mediaOffsetLabel } from "../../services/mediaSeek";
import { nodeVideoPassages, selectYouTubeRef, validYouTubeRef, validMediaSeconds } from "../../services/youtubeMedia";

let apiPromise;
function positionPlayer(player, videoId, seconds) {
  if (!player) return;
  // seekTo starts a cued video. Keep it ready until the reader presses play.
  if ([1, 2, 3].includes(player.getPlayerState())) player.seekTo(seconds, true);
  else player.cueVideoById({ videoId, startSeconds: seconds });
}
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

export default function YouTubeSourcePanel({ bundle, node, nodes, compact = false, onRenameSpeaker, seekRequest, onSeekHandled }) {
  const media = selectYouTubeRef(bundle);
  const videoId = media?.video_id;
  const videoLabel = media?.label || "Conversation recording";
  const host = useRef(null);
  const videoDetails = useRef(null);
  const transcriptDetails = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const maxPanelWidth = Math.max(240, Math.round(window.innerWidth * 0.6));
  const player = useRef(null);
  const pending = useRef(null);
  const passageList = useRef(null);
  const followPlayback = useRef(true);
  const positionedVideo = useRef(null);
  const initializedPosition = useRef(false);
  const [followEpoch,setFollowEpoch] = useState(0);
  const [error, setError] = useState("");
  const [active, setActive] = useState(null);
  const [speakerId, setSpeakerId] = useState("");
  const [speakerName, setSpeakerName] = useState("");
  const [transcriptHeight, setTranscriptHeight] = useState(compact ? 80 : 256);
  const passages = useMemo(() => (bundle.utterances || []).filter(u=>validMediaSeconds(u.timestamp_start)).sort((a,b)=>a.timestamp_start-b.timestamp_start), [bundle.utterances]);
  const selectedPassages = useMemo(() => nodeVideoPassages(node, nodes, bundle.utterances || []), [node, nodes, bundle.utterances]);
  const selectedPassageIds = useMemo(() => new Set(selectedPassages.map(u => u.id)), [selectedPassages]);
  const first = node ? selectedPassages[0]?.timestamp_start : passages[0]?.timestamp_start;
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
  useEffect(() => {
    if(!followPlayback.current) return;
    const list = passageList.current;
    const row = list?.querySelector('[aria-current="true"]');
    if (!row) return;
    const bounds = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
      list.scrollTop += rect.top - bounds.top - (list.clientHeight - rect.height) / 2;
    }
  }, [playbackPassage?.id,followEpoch]);
  const speakers = [...new Set((bundle.utterances || []).map((u) => u.speaker_id).filter((id) => id && id !== "UNKNOWN"))];

  useEffect(() => {
    const newVideo=positionedVideo.current!==videoId;
    if(newVideo){positionedVideo.current=videoId;pending.current=null;initializedPosition.current=false;}
    const alreadyInitialized=initializedPosition.current;
    initializedPosition.current=true;
    if(!node && alreadyInitialized) return;
    if (first == null) return;
    pending.current = first;
    followPlayback.current = true;
    setFollowEpoch(value=>value+1);
    setActive(first);
    positionPlayer(player.current, videoId, first);
  }, [first, node?.id,videoId]);

  useEffect(() => {
    if (!seekRequest || !validMediaSeconds(seekRequest.seconds)) return;
    if (seekRequest.videoId && seekRequest.videoId !== videoId) { onSeekHandled?.(); return; }
    const seconds = seekRequest.seconds;
    setCollapsed(false);
    if (videoDetails.current) videoDetails.current.open = true;
    if (transcriptDetails.current) transcriptDetails.current.open = true;
    pending.current = seconds;
    followPlayback.current = true;
    setFollowEpoch(value => value + 1);
    setActive(seconds);
    positionPlayer(player.current, videoId, seconds);
    onSeekHandled?.();
  }, [seekRequest, videoId, onSeekHandled]);

  useEffect(() => {
    if (!videoId) return undefined;
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
        playerVars: { playsinline: 1, autoplay: 0, origin: window.location.origin, rel: 0 },
        events: {
          onReady: () => {
            if (canceled) return;
            player.current = instance;
            instance.getIframe().title = videoLabel;
            instance.cueVideoById({videoId,startSeconds:pending.current ?? 0});
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
  }, [videoId, videoLabel]);

  if (!media) {
    const unsupported = (bundle.media_refs || []).some((ref) => ref?.provider === "youtube" && !validYouTubeRef(ref));
    return unsupported ? <aside role="status" className={`shrink-0 border-slate-200 bg-amber-50 p-3 text-xs text-slate-700 ${compact ? "border-b" : "w-[360px] max-w-[38vw] border-r"}`}>
      YouTube source unavailable: its video identity or time units could not be verified. The conversation remains readable; the original source metadata is preserved.
    </aside> : null;
  }
  const seek = (seconds) => {
    pending.current = seconds;
    followPlayback.current = true;
    setFollowEpoch(value=>value+1);
    setActive(seconds);
    positionPlayer(player.current, videoId, seconds);
  };
  const href = `${media.view_url}${active == null ? "" : `&t=${Math.floor(active)}s`}`;

  return (
    <aside aria-label="YouTube source" style={compact ? undefined : {width: collapsed ? 40 : panelWidth, maxWidth: "60vw"}} className={`lct-source-panel relative flex flex-col shrink-0 overflow-hidden border-slate-200 bg-white p-2 ${compact ? "max-h-[60dvh] border-b" : "border-r pr-3"}`}>
      <button type="button" aria-label={collapsed ? "Show source panel" : "Hide source panel"} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} className="mb-1 shrink-0 text-left text-xs text-slate-500">
        {collapsed ? (compact ? "Show source" : "›") : "Hide source"}
      </button>
      <div className={collapsed ? "hidden" : "min-h-0 overflow-y-auto"}>
      <details ref={videoDetails} open className="text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Video</summary>
      <div ref={host} className="min-h-[200px] w-full bg-stone-100" style={{ height: compact ? 200 : 210 }} />
      {error && <p role="alert" className="mt-2 text-xs text-amber-800">{error}</p>}
      {error && <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 block text-xs text-amber-700">
        {active == null ? "Open on YouTube" : `Open ${mediaOffsetLabel(active)} on YouTube`}
      </a>}
      </details>
      <details ref={transcriptDetails} open className="text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Transcript</summary>
      {!passages.length && <p className="mt-2 text-xs text-slate-500">No timestamped transcript is available.</p>}
      {passages.length > 0 && (
        <div ref={passageList} aria-label="Source passages" tabIndex={0} onWheel={()=>{followPlayback.current=false;}} onTouchMove={()=>{followPlayback.current=false;}} onKeyDown={e=>{if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"].includes(e.key))followPlayback.current=false;}} className="mt-1 space-y-1 overflow-y-auto" style={{maxHeight: transcriptHeight}}>
          {passages.map((u) => <button key={u.id} type="button" data-node-source={selectedPassageIds.has(u.id) ? "true" : undefined} aria-current={playbackPassage?.id === u.id ? "true" : undefined} onClick={() => seek(u.timestamp_start)} className={`block w-full rounded border-l-2 px-2 py-2 text-left text-xs leading-5 ${selectedPassageIds.has(u.id) ? "border-amber-400" : "border-transparent"} ${playbackPassage?.id === u.id ? "bg-amber-50" : "hover:bg-stone-50"}`}>
            <span className="text-amber-700">{mediaOffsetLabel(u.timestamp_start)}</span>{" · "}
            <span className="font-medium">{u.speaker_name || u.speaker_id || "Unknown"}</span>{" "}{u.text}
          </button>)}
        </div>
      )}
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
      </div>
      {!compact && !collapsed && <PanelResizeHandle label="Source panel width" value={Math.min(panelWidth,maxPanelWidth)} min={240} max={maxPanelWidth} onChange={setPanelWidth} />}
    </aside>
  );
}

YouTubeSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, node: PropTypes.object, nodes: PropTypes.array.isRequired, compact: PropTypes.bool, onRenameSpeaker: PropTypes.func, seekRequest: PropTypes.object, onSeekHandled: PropTypes.func };
