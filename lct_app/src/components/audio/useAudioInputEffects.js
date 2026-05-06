import { useEffect } from "react";

import { saveConversationDraft } from "../../services/apiClient";
import { deriveSuggestedConversationTitle } from "../../utils/conversationTitle";

const useFilenameFromGraph = ({
  graphData,
  fileNameWasReset,
  lastAutoSaveRef,
  setFileName,
}) => {
  useEffect(() => {
    if (
      fileNameWasReset.current &&
      graphData &&
      graphData !== lastAutoSaveRef.current.graphData &&
      graphData.length > 0
    ) {
      const initialName = deriveSuggestedConversationTitle(graphData);
      if (!initialName) return;
      setFileName(initialName);
      fileNameWasReset.current = false;
    }
  }, [graphData, setFileName, fileNameWasReset, lastAutoSaveRef]);
};

const useGraphDataSync = ({ graphData, graphDataFromSocket, backendWsRef, logToServer }) => {
  useEffect(() => {
    if (!graphData || graphDataFromSocket.current) {
      graphDataFromSocket.current = false;
      return;
    }
    if (backendWsRef.current?.readyState === WebSocket.OPEN) {
      backendWsRef.current.send(
        JSON.stringify({ type: "graph_data_update", data: graphData })
      );
      logToServer("Sent graphData update to backend.");
    }
  }, [graphData, graphDataFromSocket, backendWsRef, logToServer]);
};

/**
 * Auto-save the user-edited conversation name (browser-authoritative draft state)
 * per ADR-030 §D6. Canonical graph/chunk persistence is backend-owned and is
 * not sent from the browser through this hook.
 *
 * `graphData` and `chunkDict` are kept in the dependency list as activity
 * signals — they tell us when there is work worth attaching a name to — but
 * their contents are NOT transmitted.
 */
const useAutoSaveConversation = ({
  graphData,
  chunkDict,
  fileName,
  conversationId,
  lastAutoSaveRef,
  setMessage,
}) => {
  useEffect(() => {
    if (!graphData || !chunkDict || !fileName) return;
    if (!conversationId) return;
    const trimmed = String(fileName || "").trim();
    if (!trimmed) return;
    if (lastAutoSaveRef.current?.fileName === trimmed) return;

    const timeoutId = setTimeout(async () => {
      try {
        await saveConversationDraft(conversationId, {
          conversation_name: trimmed,
        });
        lastAutoSaveRef.current = { fileName: trimmed };
      } catch (err) {
        const detail = err?.message || "Unknown error";
        console.error("Auto-save (draft) failed:", detail);
        setMessage?.(`Auto-save failed: ${detail}`);
      }
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [graphData, chunkDict, fileName, conversationId, lastAutoSaveRef, setMessage]);
};

const useMessageDismissOnClick = ({ message, setMessage }) => {
  useEffect(() => {
    if (!message) return;
    const handleClick = () => setMessage("");
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [message, setMessage]);
};

export {
  useAutoSaveConversation,
  useFilenameFromGraph,
  useGraphDataSync,
  useMessageDismissOnClick,
};
