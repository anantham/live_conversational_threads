import { useEffect, useRef, useCallback, useState } from "react";
import { API_BASE_URL, saveConversationDraft } from "../services/apiClient";

const DEBOUNCE_MS = 30_000; // save at most once per 30 s while name is changing

/**
 * Build the beacon body for sendBeacon. We only send presentation/recovery
 * state per ADR-030 §D6 — never the graph itself.
 */
function buildBeaconBody(conversationName) {
  const payload = {};
  if (conversationName && conversationName.trim()) {
    payload.conversation_name = conversationName.trim();
  }
  return payload;
}

/**
 * Fire-and-forget beacon save used on tab close / visibility change.
 * navigator.sendBeacon is reliable even during page unload.
 *
 * Per ADR-030 §D6 only browser-authoritative draft keys are sent. Canonical
 * semantic state (nodes, relationships, claims, etc.) is persisted by the
 * backend and never originates from this hook.
 */
function beaconDraftSave(conversationId, conversationName) {
  if (!conversationId) return;
  const payload = buildBeaconBody(conversationName);
  if (Object.keys(payload).length === 0) return;
  const url = `${API_BASE_URL}/api/conversations/${conversationId}/draft`;
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  navigator.sendBeacon(url, blob);
}

/**
 * useAutoSave — browser-originated draft state persistence per ADR-030 §D6.
 *
 * The browser MUST NOT write canonical semantic state. This hook persists
 * only browser-authoritative draft fields (conversation_name; in future
 * phases: viewport, canvas_overrides, dismissed_unlock_affordances, etc.).
 *
 * Canonical graph persistence is backend-owned (live_graph_persistence,
 * import_persistence). Older versions of this hook also POSTed `nodes` to
 * `PATCH /conversations/{id}/graph`; that path is removed and the endpoint
 * is deprecated.
 *
 * @param {object} opts
 * @param {string}  opts.conversationId       - stable UUID for this session
 * @param {Array}   opts.graphData            - kept for change-detection only;
 *                                              graph data is NOT sent to server
 * @param {string}  [opts.conversationName]   - user-edited title (browser-authoritative)
 * @param {boolean} [opts.enabled=true]       - set false to pause saving
 *
 * @returns {{ saveStatus: string, lastSavedAt: Date|null, triggerSave: Function }}
 */
export function useAutoSave({
  conversationId,
  graphData,
  conversationName,
  enabled = true,
}) {
  const [saveStatus, setSaveStatus] = useState("idle"); // 'idle'|'saving'|'saved'|'error'
  const [lastSavedAt, setLastSavedAt] = useState(null);

  const lastSavedNameRef = useRef("");
  const lastSeenGraphLengthRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const isSavingRef = useRef(false);

  const doSave = useCallback(
    async (name) => {
      if (!conversationId) return;
      if (isSavingRef.current) return;
      const trimmed = (name || "").trim();
      if (!trimmed) return;
      if (trimmed === lastSavedNameRef.current) return;

      isSavingRef.current = true;
      setSaveStatus("saving");

      try {
        await saveConversationDraft(conversationId, {
          conversation_name: trimmed,
        });
        lastSavedNameRef.current = trimmed;
        setLastSavedAt(new Date());
        setSaveStatus("saved");
      } catch (err) {
        console.warn("[useAutoSave] Draft save failed:", err);
        setSaveStatus("error");
      } finally {
        isSavingRef.current = false;
      }
    },
    [conversationId]
  );

  // Debounced save triggered by either graph activity (signaling the session
  // is producing work worth keeping a name attached to) or name changes.
  useEffect(() => {
    if (!enabled) return;

    const flatLength = Array.isArray(graphData)
      ? graphData.reduce(
          (acc, chunk) => acc + (Array.isArray(chunk) ? chunk.length : 0),
          0
        )
      : 0;
    const graphChanged = flatLength !== lastSeenGraphLengthRef.current;
    lastSeenGraphLengthRef.current = flatLength;

    const nameChanged =
      (conversationName || "").trim() !== lastSavedNameRef.current;

    if (!graphChanged && !nameChanged) return;
    if (!conversationName || !conversationName.trim()) return;

    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => doSave(conversationName), DEBOUNCE_MS);

    return () => clearTimeout(debounceTimerRef.current);
  }, [graphData, conversationName, enabled, doSave]);

  // Save on tab hide / page unload — beacon ensures the save survives teardown.
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        beaconDraftSave(conversationId, conversationName);
      }
    };

    const handleBeforeUnload = () => {
      beaconDraftSave(conversationId, conversationName);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [conversationId, conversationName, enabled]);

  // Exposed manual trigger (e.g. for "End & Exit" button).
  const triggerSave = useCallback(() => {
    return doSave(conversationName);
  }, [conversationName, doSave]);

  return { saveStatus, lastSavedAt, triggerSave };
}
