import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import PanelResizeHandle from "../PanelResizeHandle";
import SourceSpeakerEditor from "./SourceSpeakerEditor";
import SourcePlaybackControls from "./SourcePlaybackControls";
import { mediaOffsetLabel } from "../../services/mediaSeek";
import { recordSourceLoadTiming } from "../../services/sourceLoadTiming";
import { nodeVideoPassages, selectYouTubeRef, validYouTubeRef, validMediaSeconds } from "../../services/youtubeMedia";

function positionPlayer(player, videoId, seconds) {
  if (!player) return;
  // seekTo starts a cued video. Keep it ready until the reader presses play.
  if ([1, 2, 3].includes(player.getPlayerState())) player.seekTo(seconds, true);
  else player.cueVideoById({ videoId, startSeconds: seconds });
}
function loadPlayerApi(signal) {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timer;
    const previous = window.onYouTubeIframeAPIReady;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
    };
    const ready = () => { cleanup(); previous?.(); resolve(window.YT); };
    const failed = () => { cleanup(); script.remove(); reject(new Error("YouTube could not load here. Retry or open the passage on YouTube below.")); };
    const abort = () => { cleanup(); script.remove(); reject(new DOMException("Source closed", "AbortError")); };
    window.onYouTubeIframeAPIReady = ready;
    signal.addEventListener("abort", abort, { once: true });
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = failed;
    timer = window.setTimeout(failed, 20000);
    document.head.appendChild(script);
  });
}

export default function YouTubeSourcePanel({ bundle, node, nodes, compact = false, onRenameSpeaker, seekRequest, onSeekHandled, onClose }) {
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
  const [loadStage, setLoadStage] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [active, setActive] = useState(null);
  const [playbackState, setPlaybackState] = useState(-1);
  const [blockedMessage, setBlockedMessage] = useState("");
  const passages = useMemo(() => (bundle.utterances || []).filter(u=>validMediaSeconds(u.timestamp_start)).sort((a,b)=>a.timestamp_start-b.timestamp_start), [bundle.utterances]);
  const selectedPassages = useMemo(() => nodeVideoPassages(node, nodes, bundle.utterances || []), [node, nodes, bundle.utterances]);
  const selectedPassageIds = useMemo(() => new Set(selectedPassages.map(u => u.id)), [selectedPassages]);
  const first = node ? selectedPassages[0]?.timestamp_start : passages[0]?.timestamp_start;
  const nodeId = node?.id;
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
  useEffect(() => {
    const newVideo=positionedVideo.current!==videoId;
    if(newVideo){positionedVideo.current=videoId;pending.current=null;initializedPosition.current=false;}
    const alreadyInitialized=initializedPosition.current;
    initializedPosition.current=true;
    if(nodeId == null && alreadyInitialized) return;
    if (first == null) return;
    pending.current = first;
    followPlayback.current = true;
    setFollowEpoch(value=>value+1);
    setActive(first);
    positionPlayer(player.current, videoId, first);
  }, [first, nodeId,videoId]);

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
    let failed = false;
    let instance;
    let clock;
    let readinessTimer;
    let elapsedTimer;
    let settled = false;
    let apiMs;
    const started = performance.now();
    const controller = new AbortController();
    const finish = outcome => {
      if (settled) return;
      settled = true;
      window.clearInterval(elapsedTimer);
      window.clearTimeout(readinessTimer);
      recordSourceLoadTiming({ outcome, retries: loadAttempt, apiMs: apiMs ?? null, elapsedMs: performance.now() - started });
    };
    const fail = message => {
      if (canceled || failed) return;
      failed = true;
      finish("error");
      window.clearInterval(clock);
      player.current = null;
      const abandoned = instance;
      instance = undefined;
      abandoned?.destroy();
      setLoadStage("error"); setError(message);
    };
    setError(""); setBlockedMessage(""); setPlaybackState(-1); setElapsed(0); setLoadStage("api");
    elapsedTimer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    const readClock = () => {
      if (canceled || failed || document.visibilityState === "hidden") return;
      const seconds = instance?.getCurrentTime?.();
      if (validMediaSeconds(seconds)) setActive(seconds);
      const state = instance?.getPlayerState?.();
      if (typeof state === "number") setPlaybackState(state);
      if (state === 1) setBlockedMessage("");
    };
    // YT replaces this child; React owns only the stable outer host.
    const child = document.createElement("div");
    host.current.replaceChildren(child);
    loadPlayerApi(controller.signal).then((YT) => {
      if (canceled) return;
      apiMs = performance.now() - started;
      setLoadStage("player");
      readinessTimer = window.setTimeout(() => fail("The video player did not become ready. Retry or open this passage on YouTube below."), 20000);
      instance = new YT.Player(child, {
        width: "100%", height: "100%", videoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { playsinline: 1, controls: 1, autoplay: 0, origin: window.location.origin, rel: 0 },
        events: {
          onReady: () => {
            if (canceled || failed) return;
            finish("success"); setError(""); setLoadStage("ready");
            player.current = instance;
            instance.getIframe().title = videoLabel;
            instance.cueVideoById({videoId,startSeconds:pending.current ?? 0});
            // YouTube has no timeupdate event. Poll while enabled (including
            // paused seeks); observing the clock must never call seekTo.
            clock = window.setInterval(readClock, 250);
          },
          onStateChange: readClock,
          onAutoplayBlocked: () => { if (!canceled && !failed) setBlockedMessage("Your browser blocked playback here. Open this passage on YouTube below."); },
          onError: ({ data } = {}) => fail(`This video cannot play embedded here${Number.isFinite(data) ? ` (YouTube error ${data})` : ""}. Retry or open the passage on YouTube below.`),
        },
      });
    }).catch((e) => { if (!canceled) fail(e.message); });
    return () => { canceled = true; finish("cancelled"); controller.abort(); window.clearInterval(clock); player.current = null; instance?.destroy(); };
  }, [videoId, videoLabel, loadAttempt]);

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
  const linkSeconds = active ?? first ?? 0;
  const href = `${media.view_url}&t=${Math.floor(linkSeconds)}s`;

  return (
    <aside aria-label="YouTube source" style={compact ? {maxHeight: "min(60dvh, 100%)"} : {width: collapsed ? 40 : panelWidth, maxWidth: "60vw"}} className={`lct-source-panel relative flex flex-col shrink-0 overflow-hidden border-slate-200 bg-white p-2 ${compact ? "border-b" : "border-r pr-3"}`}>
      <button type="button" aria-label={collapsed ? "Show source panel" : "Hide source panel"} aria-expanded={!collapsed} onClick={() => onClose ? onClose() : setCollapsed(value => !value)} className="mb-1 shrink-0 text-left text-xs text-slate-500">
        {collapsed ? (compact ? "Show source" : "›") : "Hide source"}
      </button>
      <div className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-y-auto"}>
      <details ref={videoDetails} open className="shrink-0 text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Video</summary>
      <div aria-busy={["api", "player"].includes(loadStage)} className="relative min-h-[200px] w-full bg-stone-100" style={{ height: compact ? 200 : 210 }}>
        <div ref={host} className={error ? "hidden" : "h-full w-full"} />
        {loadStage !== "ready" && <div className="absolute inset-0 flex flex-col justify-center bg-stone-100 px-4 text-sm text-slate-700">
          {error ? <p role="alert">{error}</p> : <>
            <p role="status">{loadStage === "player" ? "Preparing the video player" : "Loading YouTube"}</p>
            <p aria-hidden="true" className="mt-2 text-xs tabular-nums">{elapsed}s elapsed · Time remaining unknown</p>
          </>}
        </div>}
      </div>
      {loadStage === "ready" && player.current && <SourcePlaybackControls player={player.current} playbackState={playbackState} blockedMessage={blockedMessage} onDismissBlocked={() => setBlockedMessage("")} />}
      {error && <button type="button" className="min-h-11 text-xs text-amber-800 underline" onClick={() => { pending.current = active ?? pending.current; setLoadAttempt(value => value + 1); }}>Retry video</button>}
      <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 block min-h-11 py-3 text-xs text-amber-700 underline">
        Open on YouTube at {mediaOffsetLabel(linkSeconds)}
      </a>
      </details>
      <details ref={transcriptDetails} open className="shrink-0 text-xs text-slate-600">
        <summary className="cursor-pointer py-1">Transcript</summary>
      {!passages.length && <p className="mt-2 text-xs text-slate-500">No timestamped transcript is available.</p>}
      {passages.length > 0 && (
        <div ref={passageList} aria-label="Source passages" tabIndex={0} onWheel={()=>{followPlayback.current=false;}} onTouchMove={()=>{followPlayback.current=false;}} onKeyDown={e=>{if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"].includes(e.key))followPlayback.current=false;}} className={`mt-1 space-y-1 overflow-y-auto ${compact ? "max-h-[35dvh]" : "max-h-[48dvh]"}`}>
          {passages.map((u) => <button key={u.id} type="button" data-node-source={selectedPassageIds.has(u.id) ? "true" : undefined} aria-current={playbackPassage?.id === u.id ? "true" : undefined} onClick={() => seek(u.timestamp_start)} className={`block w-full rounded border-l-2 px-2 py-2 text-left text-xs leading-5 ${selectedPassageIds.has(u.id) ? "border-amber-400" : "border-transparent"} ${playbackPassage?.id === u.id ? "bg-amber-50" : "hover:bg-stone-50"}`}>
            <span className="text-amber-700">{mediaOffsetLabel(u.timestamp_start)}</span>{" · "}
            <span className="font-medium">{u.speaker_name || u.speaker_id || "Unknown"}</span>{" "}{u.text}
          </button>)}
        </div>
      )}
      </details>
      {onRenameSpeaker && <SourceSpeakerEditor bundle={bundle} onRenameSpeaker={onRenameSpeaker} onSeek={seek} />}
      </div>
      {!compact && !collapsed && <PanelResizeHandle label="Source panel width" value={Math.min(panelWidth,maxPanelWidth)} min={240} max={maxPanelWidth} onChange={setPanelWidth} />}
    </aside>
  );
}

YouTubeSourcePanel.propTypes = { bundle: PropTypes.object.isRequired, node: PropTypes.object, nodes: PropTypes.array.isRequired, compact: PropTypes.bool, onRenameSpeaker: PropTypes.func, seekRequest: PropTypes.object, onSeekHandled: PropTypes.func, onClose: PropTypes.func };
