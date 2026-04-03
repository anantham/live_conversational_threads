import { useLocation, useNavigate } from "react-router-dom";
import { useUpload } from "../../contexts/UploadContext";

export default function UploadToast() {
  const { isProcessing, progress, statusText, etaText, uploadConversationId } = useUpload();
  const location = useLocation();
  const navigate = useNavigate();

  // Don't show toast on the NewConversation page — it has its own inline progress
  const isOnNewPage = location.pathname === "/new";
  if (!isProcessing || isOnNewPage) return null;

  const pct = Math.round((progress || 0) * 100);

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-xs animate-slideIn">
      <div className="rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg px-4 py-3 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-gray-700 truncate flex-1">
            {statusText || "Processing upload..."}
          </p>
          <button
            onClick={() => navigate(uploadConversationId ? `/new` : "/new")}
            className="text-[10px] text-blue-600 hover:text-blue-800 whitespace-nowrap"
          >
            View
          </button>
        </div>
        {etaText && (
          <p className="text-[10px] text-gray-400">{etaText}</p>
        )}
        <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
