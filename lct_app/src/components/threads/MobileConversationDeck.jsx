import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

import { SPEAKER_COLORS } from "../graphConstants";
import { selectMediaRef } from "../../services/mediaSeek";
import MobileDeckCard from "./MobileDeckCard";
import YouTubeSourcePanel from "./YouTubeSourcePanel";
import {
  MobileDeckHeader,
  MobileDeckLiveStatus,
  MobileDeckNavigation,
} from "./MobileDeckChrome";
import MobileDeckOptions from "./MobileDeckOptions";
import useMobileConversationDeckState from "./useMobileConversationDeckState";
import {
  buildMobileConversationDeck,
  mobileDeckLiveStatus,
  mobileDeckLevelInfo,
  mobileDeckSnapshot,
  moveMobileDeck,
  returnMobileDeckToLive,
} from "./mobileConversationDeckModel";

const SWIPE_THRESHOLD = 44;
const DOMINANCE_RATIO = 1.15;

function speakerLabel(utterance) {
  return String(
    utterance?.speaker_name
      || utterance?.speaker_display
      || utterance?.speaker_id
      || "Unknown speaker",
  );
}

function buildSpeakerMap(utterances) {
  const labels = [...new Set((utterances || []).map(speakerLabel).filter(Boolean))];
  return Object.fromEntries(
    labels.map((label, index) => [label, SPEAKER_COLORS[index % SPEAKER_COLORS.length]]),
  );
}

export default function MobileConversationDeck({
  bundle,
  deckState: controlledDeckState,
  graphNodes,
  libraryStatus,
  live = false,
  onDeckStateChange,
  onDownloadTranscript,
  onOpenAnother,
  onOpenLibrary,
  onRefreshFromDrive,
  onShowMap,
  onRenameSpeaker,
}) {
  const model = useMemo(
    () => buildMobileConversationDeck(graphNodes, bundle.utterances || []),
    [bundle.utterances, graphNodes],
  );
  const { commitDeckState, deckState } = useMobileConversationDeckState({
    controlledDeckState,
    live,
    model,
    onDeckStateChange,
  });
  const [motion, setMotion] = useState("none");
  const [motionKey, setMotionKey] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const gesture = useRef(null);
  const touchGesture = useRef(null);
  const noticeTimer = useRef(null);
  useEffect(() => {
    setMotion("none");
    setMotionKey((value) => value + 1);
  }, [model]);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  const showNotice = useCallback((message) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2800);
  }, []);

  const closeMore = useCallback(() => setMoreOpen(false), []);

  const navigate = useCallback((action) => {
    const result = moveMobileDeck(model, deckState, action);
    if (!result.changed) {
      if (result.notice) showNotice(result.notice);
      return;
    }
    setNotice("");
    setMotion(action);
    setMotionKey((value) => value + 1);
    commitDeckState(result.state);
  }, [commitDeckState, deckState, model, showNotice]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (moreOpen) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target?.closest?.("input, textarea, select, a, [contenteditable='true']")) return;
      const action = {
        ArrowLeft: "previous",
        ArrowRight: "next",
        ArrowUp: "up",
        ArrowDown: "down",
      }[event.key];
      if (!action) return;
      event.preventDefault();
      navigate(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moreOpen, navigate]);

  const snapshot = mobileDeckSnapshot(model, deckState);
  const liveStatus = live ? mobileDeckLiveStatus(model, deckState) : null;
  const sourceRows = useMemo(() => {
    if (!snapshot.entry) return [];
    if (snapshot.entry.kind === "utterance") return snapshot.item ? [snapshot.item] : [];
    const ids = snapshot.item?.provenance_utterance_ids
      || snapshot.item?.provenance_source_ref?.utterance_ids
      || snapshot.item?.source_ref?.utterance_ids
      || snapshot.item?.utterance_ids
      || [];
    return ids.map((id) => model.utteranceById.get(String(id))).filter(Boolean);
  }, [model.utteranceById, snapshot.entry, snapshot.item]);
  const speakerColorMap = useMemo(
    () => buildSpeakerMap(bundle.utterances || []),
    [bundle.utterances],
  );
  const mediaRef = useMemo(() => selectMediaRef(bundle.media_refs || []), [bundle.media_refs]);
  const title = bundle.conversation_title || bundle.conversation_name || "Conversation";
  const parentTitle = snapshot.parent?.node_name || snapshot.parent?.title || "";

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0 || event.target?.closest?.("button, a, input, select, textarea")) return;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerCancel = useCallback(() => {
    gesture.current = null;
    touchGesture.current = null;
  }, []);

  const handlePointerUp = useCallback((event) => {
    const start = gesture.current;
    gesture.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    if (Math.max(absoluteX, absoluteY) < SWIPE_THRESHOLD) return;
    if (absoluteX > absoluteY * DOMINANCE_RATIO) {
      navigate(deltaX < 0 ? "next" : "previous");
    } else if (event.pointerType !== "touch" && absoluteY > absoluteX * DOMINANCE_RATIO) {
      navigate(deltaY > 0 ? "down" : "up");
    }
  }, [navigate]);

  const handleTouchStart = useCallback((event) => {
    const touch = event.touches?.[0];
    if (!touch || event.target?.closest?.("button, a, input, select, textarea")) return;
    const card = event.target?.closest?.('[data-testid="mobile-deck-card"]');
    touchGesture.current = {
      x: touch.clientX,
      y: touch.clientY,
      scrollable: Boolean(card && card.scrollHeight > card.clientHeight + 1),
    };
  }, []);

  const handleTouchEnd = useCallback((event) => {
    const start = touchGesture.current;
    touchGesture.current = null;
    const touch = event.changedTouches?.[0];
    if (!start || !touch || start.scrollable) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    if (absoluteY < SWIPE_THRESHOLD || absoluteY <= absoluteX * DOMINANCE_RATIO) return;
    navigate(deltaY > 0 ? "down" : "up");
  }, [navigate]);

  const announceLayer = useCallback((level) => {
    const info = mobileDeckLevelInfo(level);
    const count = snapshot.counts[level] || 0;
    if (count === 0) {
      showNotice(`No ${info.plural} were generated for this conversation.`);
    } else {
      showNotice(`${count} ${count === 1 ? info.singular : info.plural} in this conversation.`);
    }
  }, [showNotice, snapshot.counts]);

  const handleReturnToLive = useCallback(() => {
    setNotice("");
    setMotion("next");
    setMotionKey((value) => value + 1);
    commitDeckState(returnMobileDeckToLive(model, deckState));
  }, [commitDeckState, deckState, model]);

  const motionClass = {
    previous: "lct-deck-enter-left",
    next: "lct-deck-enter-right",
    up: "lct-deck-enter-up",
    down: "lct-deck-enter-down",
  }[motion] || "";

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] font-sans text-slate-800">
      <div
        data-testid="mobile-deck-background"
        aria-hidden={moreOpen ? "true" : undefined}
        inert={moreOpen ? "" : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        <MobileDeckHeader
          levelInfo={snapshot.levelInfo}
          onMore={() => setMoreOpen(true)}
          onShowMap={onShowMap}
          position={snapshot.position || 0}
          title={title}
          total={snapshot.total || 0}
        />

        {liveStatus && (
          <MobileDeckLiveStatus
            isFollowingLive={liveStatus.isFollowingLive}
            onReturnToLive={handleReturnToLive}
            updatesBehind={liveStatus.updatesBehind}
          />
        )}

        <main className="flex min-h-0 flex-1 flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <YouTubeSourcePanel bundle={bundle} node={snapshot.item} nodes={graphNodes} compact onRenameSpeaker={onRenameSpeaker} />
        <div className="h-5 shrink-0 px-2 text-center">
          {parentTitle && (
            <p className="truncate text-xs text-slate-400" title={parentTitle}>
              within {parentTitle}
            </p>
          )}
        </div>

        <div
          data-testid="mobile-deck-stage"
          className="relative mt-2 min-h-0 flex-1 touch-pan-y"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handlePointerCancel}
        >
          {snapshot.item ? (
            <div key={`${snapshot.entry.kind}:${snapshot.entry.id}:${motionKey}`} className={`h-full ${motionClass}`}>
              <MobileDeckCard
                mediaRef={mediaRef}
                snapshot={snapshot}
                sourceRows={sourceRows}
                speakerColorMap={speakerColorMap}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-8 text-center">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">No conversation structure</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  This artifact contains no authored moments, ideas, topics, themes, or arcs.
                </p>
              </div>
            </div>
          )}
        </div>

        <MobileDeckNavigation navigate={navigate} snapshot={snapshot} />
        </main>

      </div>

      <div
        role="status"
        aria-atomic="true"
        aria-live="polite"
        data-testid="mobile-deck-notice"
        className={`fixed inset-x-4 z-[100] mx-auto max-w-sm rounded-xl bg-slate-900 px-4 py-3 text-center text-sm text-white shadow-lg transition-all duration-200 ${
          moreOpen
            ? "top-[calc(1rem+env(safe-area-inset-top))]"
            : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))]"
        } ${
          notice ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
        }`}
      >
        {notice}
      </div>

      <MobileDeckOptions
        bundle={bundle}
        counts={snapshot.counts}
        libraryStatus={libraryStatus}
        live={live}
        onAnnounceLayer={announceLayer}
        onClose={closeMore}
        onDownloadTranscript={onDownloadTranscript}
        onOpenAnother={onOpenAnother}
        onOpenLibrary={onOpenLibrary}
        onRefreshFromDrive={onRefreshFromDrive}
        open={moreOpen}
      />
    </div>
  );
}

MobileConversationDeck.propTypes = {
  bundle: PropTypes.shape({
    conversation_title: PropTypes.string,
    conversation_name: PropTypes.string,
    coverage: PropTypes.object,
    media_refs: PropTypes.arrayOf(PropTypes.object),
    utterances: PropTypes.arrayOf(PropTypes.object),
  }).isRequired,
  deckState: PropTypes.shape({
    trail: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.string.isRequired,
      kind: PropTypes.oneOf(["node", "utterance"]).isRequired,
    })).isRequired,
  }),
  graphNodes: PropTypes.arrayOf(PropTypes.object).isRequired,
  libraryStatus: PropTypes.shape({
    state: PropTypes.string,
    message: PropTypes.string,
  }),
  live: PropTypes.bool,
  onDeckStateChange: PropTypes.func,
  onDownloadTranscript: PropTypes.func.isRequired,
  onOpenAnother: PropTypes.func.isRequired,
  onOpenLibrary: PropTypes.func.isRequired,
  onRefreshFromDrive: PropTypes.func,
  onShowMap: PropTypes.func.isRequired,
  onRenameSpeaker: PropTypes.func,
};
