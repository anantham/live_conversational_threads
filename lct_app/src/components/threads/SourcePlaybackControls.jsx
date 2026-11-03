import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Pause, Play } from "lucide-react";
import { recordSourcePlaybackTiming } from "../../services/sourceLoadTiming";

export default function SourcePlaybackControls({ player, playbackState, blockedMessage, onDismissBlocked }) {
  const [requested, setRequested] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [warning, setWarning] = useState("");
  const pause = playbackState === 1 || playbackState === 3;
  const waiting = (requested && playbackState !== 1) || playbackState === 3;
  const notice = blockedMessage || warning;
  const attempts = useRef(0);
  const latestNotice = useRef(notice);
  const latestState = useRef(playbackState);
  latestNotice.current = notice;
  latestState.current = playbackState;

  useEffect(() => {
    if ([0, 1, 2].includes(playbackState)) setRequested(false);
    if (playbackState === 1) setWarning("");
  }, [playbackState]);

  useEffect(() => {
    if (!waiting || notice) return undefined;
    const started = performance.now();
    setElapsed(0);
    const clock = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000);
    const timeout = window.setTimeout(() => {
      setWarning("Playback is taking longer than expected. Try the video again or open this passage on YouTube below.");
      setRequested(false);
    }, 20000);
    return () => {
      window.clearInterval(clock); window.clearTimeout(timeout);
      recordSourcePlaybackTiming({ outcome: latestState.current === 1 ? "success" : latestNotice.current ? "error" : "cancelled",
        elapsedMs: performance.now() - started, retries: Math.max(0, attempts.current - 1) });
    };
  }, [waiting, notice, player]);

  const togglePlayback = () => {
    setWarning("");
    onDismissBlocked();
    try {
      if (pause) { player.pauseVideo(); setRequested(false); }
      else { attempts.current += 1; setRequested(true); player.playVideo(); }
    } catch {
      setRequested(false);
      setWarning("Playback could not start here. Retry the video or open this passage on YouTube below.");
    }
  };

  return <div className="mt-2">
    <button type="button" disabled={requested && !pause && !notice} onClick={togglePlayback} className="flex min-h-11 items-center gap-2 rounded border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-stone-50 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">
      {pause ? <Pause aria-hidden="true" size={16} /> : <Play aria-hidden="true" size={16} />}
      {pause ? "Pause video" : "Play video"}
    </button>
    {waiting && !notice && <div className="mt-2 text-xs text-slate-600">
      <p role="status">{playbackState === 3 ? "Buffering video" : "Starting playback"}</p>
      <p aria-hidden="true" className="mt-1 tabular-nums">{elapsed}s elapsed · Time remaining unknown</p>
    </div>}
    {notice && <p role="alert" className="mt-2 text-xs text-amber-800">{notice}</p>}
  </div>;
}

SourcePlaybackControls.propTypes = {
  player: PropTypes.object.isRequired,
  playbackState: PropTypes.number.isRequired,
  blockedMessage: PropTypes.string.isRequired,
  onDismissBlocked: PropTypes.func.isRequired,
};
