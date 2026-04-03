import { createContext, useCallback, useContext, useRef, useState } from "react";
import PropTypes from "prop-types";
import useFileUploadStream from "../components/upload/useFileUploadStream";

const UploadContext = createContext(null);

export function UploadProvider({ children }) {
  // Graph data accumulated from upload events — consumed by NewConversation
  const [uploadGraphData, setUploadGraphData] = useState(null);
  const [uploadChunkDict, setUploadChunkDict] = useState(null);
  const [uploadGraphPatches, setUploadGraphPatches] = useState([]);
  const [uploadConversationId, setUploadConversationId] = useState(null);
  const [uploadFileName, setUploadFileName] = useState(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const subscribersRef = useRef({});

  // Callbacks that buffer data and forward to any active subscriber (the page)
  const onDataReceived = useCallback((data) => {
    setUploadGraphData(data);
    subscribersRef.current.onDataReceived?.(data);
  }, []);

  const onChunksReceived = useCallback((chunks) => {
    setUploadChunkDict((prev) => ({ ...prev, ...chunks }));
    subscribersRef.current.onChunksReceived?.(chunks);
  }, []);

  const onGraphPatchReceived = useCallback((patch) => {
    setUploadGraphPatches((prev) => [...prev, patch]);
    subscribersRef.current.onGraphPatchReceived?.(patch);
  }, []);

  const setConversationId = useCallback((id) => {
    setUploadConversationId(id);
    subscribersRef.current.setConversationId?.(id);
  }, []);

  const setFileName = useCallback((name) => {
    setUploadFileName(name);
    subscribersRef.current.setFileName?.(name);
  }, []);

  const setMessage = useCallback((msg) => {
    setUploadMessage(msg);
    subscribersRef.current.setMessage?.(msg);
  }, []);

  const stream = useFileUploadStream({
    onDataReceived,
    onChunksReceived,
    onGraphPatchReceived,
    setConversationId,
    setFileName,
    setMessage,
  });

  // Subscribe: page components register their own callbacks so they receive
  // events in real-time while mounted. When they unmount, unsubscribe.
  const subscribe = useCallback((callbacks) => {
    subscribersRef.current = callbacks || {};
  }, []);

  const unsubscribe = useCallback(() => {
    subscribersRef.current = {};
  }, []);

  // Consume buffered data — called by NewConversation when it mounts
  // during or after an upload to pick up any data it missed.
  const consumeBuffered = useCallback(() => {
    const data = {
      graphData: uploadGraphData,
      chunkDict: uploadChunkDict,
      graphPatches: uploadGraphPatches,
      conversationId: uploadConversationId,
      fileName: uploadFileName,
      message: uploadMessage,
    };
    return data;
  }, [uploadGraphData, uploadChunkDict, uploadGraphPatches, uploadConversationId, uploadFileName, uploadMessage]);

  const clearBuffered = useCallback(() => {
    setUploadGraphData(null);
    setUploadChunkDict(null);
    setUploadGraphPatches([]);
    setUploadConversationId(null);
    setUploadFileName(null);
    setUploadMessage("");
  }, []);

  return (
    <UploadContext.Provider
      value={{
        ...stream,
        subscribe,
        unsubscribe,
        consumeBuffered,
        clearBuffered,
        uploadConversationId,
        uploadFileName,
        uploadMessage,
      }}
    >
      {children}
    </UploadContext.Provider>
  );
}

UploadProvider.propTypes = {
  children: PropTypes.node.isRequired,
};

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within UploadProvider");
  return ctx;
}
