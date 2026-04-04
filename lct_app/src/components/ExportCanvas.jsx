import PropTypes from "prop-types";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../services/apiClient";

export default function ExportCanvas({ graphData, fileName }) {
  const { conversationId } = useParams();
  const [isExporting, setIsExporting] = useState(false);
  const [includeChunks, setIncludeChunks] = useState(false);

  const isExportDisabled = !graphData || graphData.length === 0 || !conversationId;

  const handleExport = async () => {
    if (isExportDisabled) {
      console.warn("Export action attempted while disabled.");
      return;
    }

    setIsExporting(true);

    const exportPath = `/export/obsidian-canvas/${conversationId}?include_chunks=${includeChunks}`;
    const transcriptPath = `/export/obsidian-canvas/${conversationId}/transcript`;
    console.log('[ExportCanvas] Starting export...');
    console.log('[ExportCanvas] URL path:', exportPath);
    console.log('[ExportCanvas] conversationId:', conversationId);
    console.log('[ExportCanvas] includeChunks:', includeChunks);

    try {
      const response = await apiFetch(exportPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      console.log('[ExportCanvas] Response status:', response.status);
      console.log('[ExportCanvas] Response statusText:', response.statusText);
      console.log('[ExportCanvas] Response ok:', response.ok);

      if (!response.ok) {
        // Try to get error details from response body
        let errorDetails;
        try {
          errorDetails = await response.json();
          console.error('[ExportCanvas] Backend error details:', errorDetails);
        } catch {
          // Response might not be JSON
          const textError = await response.text();
          console.error('[ExportCanvas] Backend error (text):', textError);
          errorDetails = { message: textError };
        }

        throw new Error(
          `Export failed (${response.status} ${response.statusText}): ${
            errorDetails?.detail || errorDetails?.message || 'Unknown error'
          }`
        );
      }

      const canvasData = await response.json();
      console.log('[ExportCanvas] Canvas data received, keys:', Object.keys(canvasData));

      // Download as .canvas file
      const blob = new Blob([JSON.stringify(canvasData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName || "conversation"}.canvas`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const transcriptResponse = await apiFetch(transcriptPath, {
        method: "POST",
      });
      if (!transcriptResponse.ok) {
        let transcriptError = "Unknown transcript export error";
        try {
          const transcriptJson = await transcriptResponse.json();
          transcriptError = transcriptJson?.detail || transcriptError;
        } catch {
          transcriptError = await transcriptResponse.text();
        }
        throw new Error(`Transcript export failed: ${transcriptError}`);
      }
      const transcriptBlob = await transcriptResponse.blob();
      const transcriptUrl = URL.createObjectURL(transcriptBlob);
      const transcriptAnchor = document.createElement("a");
      transcriptAnchor.href = transcriptUrl;
      transcriptAnchor.download = `${fileName || "conversation"}.txt`;
      document.body.appendChild(transcriptAnchor);
      transcriptAnchor.click();
      document.body.removeChild(transcriptAnchor);
      URL.revokeObjectURL(transcriptUrl);

      console.log("[ExportCanvas] ✅ Canvas and transcript exported successfully");
    } catch (error) {
      console.error("[ExportCanvas] ❌ Export failed:");
      console.error("[ExportCanvas] Error type:", error.constructor.name);
      console.error("[ExportCanvas] Error message:", error.message);
      console.error("[ExportCanvas] Full error object:", error);
      console.error("[ExportCanvas] Stack trace:", error.stack);

      // Show detailed error to user
      alert(`Failed to export canvas:\n\n${error.message}\n\nCheck the browser console for more details.`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        className={`h-full px-4 py-2 rounded-lg shadow-md text-sm font-semibold whitespace-nowrap flex items-center transition
          ${
            isExportDisabled || isExporting
              ? "bg-gray-200 cursor-not-allowed"
              : "bg-purple-500 hover:bg-purple-600 text-white"
          }`}
        onClick={handleExport}
        disabled={isExportDisabled || isExporting}
        title={
          isExportDisabled
            ? "No data to export"
            : "Export as Obsidian Canvas"
        }
      >
        {isExporting ? "Exporting..." : "Export to Canvas"}
      </button>

      {/* Optional: Checkbox to include chunks */}
      {!isExportDisabled && (
        <label className="flex items-center text-xs text-white gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={includeChunks}
            onChange={(e) => setIncludeChunks(e.target.checked)}
            className="cursor-pointer"
          />
          Include chunks
        </label>
      )}
    </div>
  );
}

ExportCanvas.propTypes = {
  graphData: PropTypes.array,
  fileName: PropTypes.string,
};
