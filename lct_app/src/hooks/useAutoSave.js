import { useEffect, useRef, useCallback, useState } from "react";
import { API_BASE_URL } from "../services/apiClient";

const DEBOUNCE_MS = 30_000; // save at most once per 30 s while graph is changing

/**
 * Flatten chunked graphData (Array<Array<Node>>) to a flat node list.
 * The backend persist_import_graph expects a flat list.
 */
function flattenGraphData(graphData) {
  if (!Array.isArray(graphData)) return [];
  return graphData.flatMap((chunk) => (Array.isArray(chunk) ? chunk : []));
}

/**
 * Fire-and-forget beacon save used on tab close / visibility change.
 * navigator.sendBeacon is reliable even during page unload.
 */
function beaconSave(conversationId, nodes, conversationName) {
  if (!conversationId || nodes.length === 0) return;
  const url = `${API_BASE_URL}/conversations/${conversationId}/graph`;
  const payload = JSON.stringify({ nodes, conversation_name: conversationName || null });
  const blob = new Blob([payload], { type: "application/json" });
  navigator.sendBeacon(url, blob);
}

/**
 * useAutoSave — persists live graph state to the backend DB periodically
 * and on tab hide / page unload, preventing data loss when the tab closes.
 *
 * @param {object} opts
 * @param {string}  opts.conversationId   - stable UUID for this session
 * @param {Array}   opts.graphData        - chunked graph (Array<Array<Node>>)
 * @param {string}  [opts.conversationName] - optional display name
 * @param {boolean} [opts.enabled=true]   - set false to pause saving
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

  // Track the node count that was last successfully saved so we skip no-op saves
  const lastSavedCountRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const isSavingRef = useRef(false);

  const doSave = useCallback(
    async (nodes) => {
      if (!conversationId || nodes.length === 0) return;
      if (isSavingRef.current) return;

      isSavingRef.current = true;
      setSaveStatus("saving");

      try {
        const resp = await fetch(
          `${API_BASE_URL}/conversations/${conversationId}/graph`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nodes,
              conversation_name: conversationName || null,
            }),
          }
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }

        lastSavedCountRef.current = nodes.length;
        setLastSavedAt(new Date());
        setSaveStatus("saved");
      } catch (err) {
        console.warn("[useAutoSave] Save failed:", err);
        setSaveStatus("error");
      } finally {
        isSavingRef.current = false;
      }
    },
    [conversationId, conversationName]
  );

  // Debounced save triggered by graphData changes
  useEffect(() => {
    if (!enabled) return;

    const nodes = flattenGraphData(graphData);
    if (nodes.length === 0) return;
    // Skip if nothing new since last save
    if (nodes.length === lastSavedCountRef.current) return;

    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => doSave(nodes), DEBOUNCE_MS);

    return () => clearTimeout(debounceTimerRef.current);
  }, [graphData, enabled, doSave]);

  // Save on tab hide (visibilitychange) and page unload (beforeunload)
  // Use beacon so the save survives the page being torn down
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const nodes = flattenGraphData(graphData);
        beaconSave(conversationId, nodes, conversationName);
      }
    };

    const handleBeforeUnload = () => {
      const nodes = flattenGraphData(graphData);
      beaconSave(conversationId, nodes, conversationName);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  // graphData intentionally in deps: we want the latest snapshot captured in the closure
  }, [conversationId, conversationName, enabled, graphData]);

  // Exposed manual trigger (e.g. for "End & Exit" button)
  const triggerSave = useCallback(() => {
    const nodes = flattenGraphData(graphData);
    return doSave(nodes);
  }, [graphData, doSave]);

  return { saveStatus, lastSavedAt, triggerSave };
}
