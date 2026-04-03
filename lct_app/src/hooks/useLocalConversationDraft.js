import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteLatestDraft,
  isMeaningfulLocalDraft,
  loadLatestDraft,
  saveLatestDraft,
  summarizeLocalDraft,
} from "../services/localDraftStore";

const SAVE_DEBOUNCE_MS = 1500;

export default function useLocalConversationDraft({ snapshot, enabled = true }) {
  const [availableDraft, setAvailableDraft] = useState(null);
  const [isCheckingDraft, setIsCheckingDraft] = useState(true);
  const snapshotRef = useRef(snapshot);
  const saveTimerRef = useRef(null);

  snapshotRef.current = snapshot;

  useEffect(() => {
    let cancelled = false;

    const loadDraft = async () => {
      try {
        const draft = await loadLatestDraft();
        if (!cancelled) {
          setAvailableDraft(draft);
        }
      } catch (error) {
        console.warn("[LocalDraft] Failed to load latest draft:", error);
      } finally {
        if (!cancelled) {
          setIsCheckingDraft(false);
        }
      }
    };

    void loadDraft();

    return () => {
      cancelled = true;
    };
  }, []);

  const persistDraftNow = useCallback(
    async (candidate = snapshotRef.current) => {
      if (!enabled || !isMeaningfulLocalDraft(candidate)) {
        return null;
      }
      try {
        const saved = await saveLatestDraft({
          ...candidate,
          updatedAt: new Date().toISOString(),
        });
        if (saved) {
          setAvailableDraft(saved);
        }
        return saved;
      } catch (error) {
        console.warn("[LocalDraft] Failed to persist latest draft:", error);
        return null;
      }
    },
    [enabled]
  );

  useEffect(() => {
    window.clearTimeout(saveTimerRef.current);
    if (!enabled || !isMeaningfulLocalDraft(snapshot)) {
      return undefined;
    }

    saveTimerRef.current = window.setTimeout(() => {
      void persistDraftNow(snapshot);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(saveTimerRef.current);
    };
  }, [enabled, persistDraftNow, snapshot]);

  useEffect(() => {
    if (!enabled) return undefined;

    const flushDraft = () => {
      if (!isMeaningfulLocalDraft(snapshotRef.current)) return;
      void persistDraftNow(snapshotRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushDraft();
      }
    };

    window.addEventListener("beforeunload", flushDraft);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", flushDraft);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, persistDraftNow]);

  const restoreAvailableDraft = useCallback(() => {
    const draft = availableDraft;
    setAvailableDraft(null);
    return draft;
  }, [availableDraft]);

  const discardAvailableDraft = useCallback(async () => {
    try {
      await deleteLatestDraft();
      setAvailableDraft(null);
    } catch (error) {
      console.warn("[LocalDraft] Failed to discard latest draft:", error);
    }
  }, []);

  const availableDraftSummary = useMemo(
    () => summarizeLocalDraft(availableDraft),
    [availableDraft]
  );

  return {
    availableDraft,
    availableDraftSummary,
    discardAvailableDraft,
    isCheckingDraft,
    persistDraftNow,
    restoreAvailableDraft,
  };
}
