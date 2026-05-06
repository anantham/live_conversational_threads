import { useEffect } from "react";
import { saveConversationDraft } from "../services/apiClient";

export default function SaveJson({ chunkDict, graphData, conversationId, setMessage, message, fileName, setFileName }) {
  // Button is enabled only when there's actually content worth naming.
  // graphData/chunkDict are read here purely as activity signals; their
  // contents are never sent — the backend already has the canonical state
  // (ADR-030 §P7). This button only updates the user-edited title.
  const isSaveDisabled =
    !chunkDict || Object.keys(chunkDict).length === 0 || !graphData || graphData.length === 0;

  const handleSave = async () => {
    if (isSaveDisabled) return;

    const newName = prompt("Enter a name for your conversation file:", fileName || "");
    if (!newName) {
      setMessage("Save canceled. No file name provided.");
      return;
    }

    const trimmed = String(newName).trim();
    if (!trimmed) {
      setMessage("Save canceled. Name cannot be empty.");
      return;
    }

    setFileName(trimmed);

    try {
      await saveConversationDraft(conversationId, { conversation_name: trimmed });
      setMessage(`Renamed to "${trimmed}".`);
    } catch (err) {
      console.error("Rename failed:", err);
      setMessage(`Rename failed: ${err?.message || "Unknown error"}`);
    }
  };

  useEffect(() => {
    if (!message) return;

    const handleClick = () => {
      setMessage("");
    };

    window.addEventListener("click", handleClick);

    return () => {
      window.removeEventListener("click", handleClick);
    };
  }, [message]);

  return (
    <div className="flex flex-col items-center space-y-2">
      <button
        className={`px-4 py-2 rounded-lg text-sm font-semibold  
          ${
            isSaveDisabled
              ? "bg-gray-200 cursor-not-allowed"
              : "bg-blue-300 hover:bg-blue-400 text-white"
          }`}
        onClick={handleSave}
        disabled={isSaveDisabled}
        title={isSaveDisabled ? "No data to save" : "Export conversation"}
      >
        Rename Conversation
      </button>

      {message && (
        <div className="text-sm text-white bg-gray-900 px-3 py-1 rounded shadow">
          {message}
        </div>
      )}
    </div>
  );
}