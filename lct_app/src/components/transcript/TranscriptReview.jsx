import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import useTranscriptReview from "./useTranscriptReview";
import TranscriptReviewRow from "./TranscriptReviewRow";
import { containsTime, mediaTime } from "./transcriptReviewTiming";

const EMPTY_ROWS = [];

export default function TranscriptReview({ conversationId, visible, audioUrl, selectedNode, onCorrected }) {
  const { data, operation, elapsed, error, reload, save, stopWaiting } = useTranscriptReview(conversationId);
  const audio = useRef(null);
  const scroll = useRef(null);
  const pendingSeek = useRef(null);
  const lastSelectedNode = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [following, setFollowing] = useState(true);
  const [pageSize, setPageSize] = useState(200);
  const [audioStatus, setAudioStatus] = useState("");
  const [audioBusyAt, setAudioBusyAt] = useState(null);
  const [audioElapsed, setAudioElapsed] = useState(0);
  const canSeek = Boolean(audioUrl && data?.timing_basis === "recording_relative");
  const rows = data?.utterances || EMPTY_ROWS;
  const activeId = canSeek ? rows.find((row) => containsTime(row.timestamp_start, row.timestamp_end, currentTime))?.id : null;
  const applySeek = useCallback(() => {
    if (!audio.current || pendingSeek.current == null || audio.current.readyState < 1) return;
    try {
      audio.current.currentTime = pendingSeek.current;
      pendingSeek.current = null;
      audio.current.play()?.catch(() => setAudioStatus("Press Play to continue listening."));
    } catch { setAudioStatus("Waiting for audio to become seekable."); }
  }, []);
  const seek = useCallback((time) => {
    if (!canSeek || mediaTime(time) == null) return;
    pendingSeek.current = time;
    applySeek();
  }, [canSeek, applySeek]);
  useEffect(() => {
    if (canSeek && selectedNode && !visible && selectedNode.id !== lastSelectedNode.current) {
      lastSelectedNode.current = selectedNode.id;
      seek(selectedNode.timestamp_start ?? selectedNode.start_time);
    }
  }, [selectedNode, visible, seek, canSeek]);
  useEffect(() => {
    if (!audioBusyAt) return undefined;
    const timer = setInterval(() => setAudioElapsed(Math.floor((Date.now() - audioBusyAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [audioBusyAt]);
  useEffect(() => {
    if (!following || !visible || !activeId) return;
    const index = rows.findIndex((row) => row.id === activeId);
    if (index >= pageSize) { setPageSize(index + 100); return; }
    const element = [...(scroll.current?.querySelectorAll("[data-utterance-id]") || [])].find((node) => node.dataset.utteranceId === activeId);
    if (element && scroll.current) scroll.current.scrollTop = Math.max(0, element.offsetTop - scroll.current.offsetTop - scroll.current.clientHeight / 3);
  }, [activeId, following, visible, rows, pageSize]);
  const saveRow = useCallback(async (row, text) => {
    const result = await save(row, text);
    if (result) onCorrected?.();
    return result;
  }, [save, onCorrected]);
  const pauseFollow = useCallback(() => setFollowing(false), []);
  const beginEditing = useCallback(() => { setFollowing(false); audio.current?.pause(); }, []);
  const mediaBusy = (label) => { setAudioStatus(label); setAudioBusyAt(Date.now()); setAudioElapsed(0); };
  const retryAudio = () => {
    pendingSeek.current ??= mediaTime(audio.current?.currentTime);
    audio.current?.load();
    mediaBusy("Loading audio");
  };
  const mediaReady = () => { setAudioStatus(""); setAudioBusyAt(null); applySeek(); };
  return <section aria-label="Conversation transcript" className={visible ? "absolute inset-0 flex flex-col bg-[#fdfdfb]" : "absolute inset-x-0 bottom-0"}>
    <div hidden={!visible} className="min-h-0 flex-1 flex-col" style={visible ? { display: "flex" } : undefined}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2 sm:px-8">
        <h2 className="text-base font-semibold text-slate-800">Transcript</h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => setFollowing((value) => !value)} aria-pressed={following}
            className="min-h-11 rounded px-3 text-sm text-slate-700 hover:bg-slate-100">{following ? "Following playback" : "Follow playback"}</button>
          <button type="button" disabled={Boolean(operation)} onClick={() => void reload()}
            className="min-h-11 rounded px-3 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50">Reload</button>
        </div>
      </div>
      {data?.graph_refresh_required && <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">Transcript corrected. Graph summaries and excerpts may need refresh.</p>}
      {operation && <div role="status" className="px-4 py-2 text-sm text-slate-600">{operation} · {elapsed}s elapsed · Time remaining unknown <button type="button" onClick={stopWaiting} className="ml-2 min-h-11 underline">Stop waiting</button></div>}
      {error && <p role="alert" className="px-4 py-2 text-sm text-red-700">{error} Your correction draft is kept here.</p>}
      <div ref={scroll} onWheel={pauseFollow} onTouchMove={pauseFollow}
        onKeyDown={(event) => { if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) pauseFollow(); }}
        className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-8" tabIndex={0} aria-label="Transcript passages">
        <div className="mx-auto max-w-[72ch] divide-y divide-slate-200">
          {rows.slice(0, pageSize).map((row) => <TranscriptReviewRow key={row.id} row={row} currentTime={currentTime}
            canSeek={canSeek} onSeek={seek} onSave={saveRow} busy={Boolean(operation)} onEditing={beginEditing} />)}
          {!operation && data && !rows.length && <p className="py-12 text-sm text-slate-600">No retained transcript passages yet.</p>}
          {rows.length > pageSize && <button type="button" onClick={() => setPageSize((value) => value + 200)} className="min-h-11 py-3 text-sm text-slate-700 underline">Show more passages</button>}
        </div>
      </div>
    </div>
    <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-2 sm:px-8">
      {audioUrl ? <audio ref={audio} src={audioUrl} controls preload="metadata" aria-label="Conversation audio"
        className="mx-auto h-10 w-full max-w-3xl" onTimeUpdate={() => setCurrentTime(audio.current.currentTime)}
        onLoadedMetadata={mediaReady} onCanPlay={mediaReady} onPlaying={mediaReady} onSeeked={mediaReady}
        onWaiting={() => mediaBusy("Buffering audio")} onStalled={() => mediaBusy("Audio stalled")}
        onSeeking={() => mediaBusy("Seeking audio")} onError={() => { setAudioStatus("Audio could not load. Retry audio or keep reading."); setAudioBusyAt(null); }} />
        : <p className="text-sm text-slate-600">Audio unavailable. You can still read and correct the transcript.</p>}
      {audioUrl && data?.timing_basis === "caption_relative" && <p className="mt-1 text-xs text-slate-600">Caption times are not aligned with this audio. Transcript seeking is unavailable.</p>}
      {audioStatus && <div role="status" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">{audioStatus}{audioBusyAt && ` · ${audioElapsed}s elapsed · Time remaining unknown`}
        <button type="button" onClick={retryAudio} className="min-h-11 underline">Retry audio</button>
      </div>}
    </div>
  </section>;
}
TranscriptReview.propTypes = { conversationId: PropTypes.string.isRequired, visible: PropTypes.bool.isRequired,
  audioUrl: PropTypes.string, selectedNode: PropTypes.object, onCorrected: PropTypes.func };
