import { useEffect } from "react";

import { saveConversationToServer } from "../../utils/SaveConversation";

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
      graphData?.[0]?.[0]?.node_name
    ) {
      const initialName = graphData[0][0].node_name.replace(/[/:*?"<>|]/g, "");
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

const useAutoSaveConversation = ({
  graphData,
  chunkDict,
  fileName,
  conversationId,
  lastAutoSaveRef,
}) => {
  useEffect(() => {
    if (!graphData || !chunkDict || !fileName) return;
    const timeoutId = setTimeout(async () => {
      try {
        await saveConversationToServer({
          fileName,
          graphData,
          chunkDict,
          conversationId,
        });
        lastAutoSaveRef.current = { graphData, chunkDict };
      } catch (err) {
        console.error("Silent auto-save failed:", err);
      }
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [graphData, chunkDict, fileName, conversationId, lastAutoSaveRef]);
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
