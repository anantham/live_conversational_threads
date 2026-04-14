import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, FolderOpen, FileUp, Bookmark, BarChart3, Settings } from "lucide-react";
import ServiceStatus from "../components/ServiceStatus";
import { loadLatestDraft, summarizeLocalDraft } from "../services/localDraftStore";

export default function Home() {
  const navigate = useNavigate();
  const [draftSummary, setDraftSummary] = useState(null);
  const [pendingFeatureToast, setPendingFeatureToast] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadDraft = async () => {
      try {
        const draft = await loadLatestDraft();
        if (!cancelled) {
          setDraftSummary(summarizeLocalDraft(draft));
        }
      } catch (error) {
        console.warn("[Home] Failed to inspect local draft state:", error);
      }
    };

    void loadDraft();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pendingFeatureToast) return undefined;

    const timeoutId = window.setTimeout(() => {
      setPendingFeatureToast("");
    }, 2200);

    return () => window.clearTimeout(timeoutId);
  }, [pendingFeatureToast]);

  const showPendingFeatureToast = (featureName) => {
    setPendingFeatureToast(`${featureName} is pending in this build.`);
  };

  return (
    <div className="relative flex h-[100dvh] w-screen flex-col items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] font-sans">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.06),transparent_42%)]" />

      <div className="relative mb-12 text-center">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.42em] text-slate-400">
          live conversational
        </p>
        <h1 className="text-6xl font-semibold leading-none tracking-[-0.09em] text-slate-800 sm:text-7xl md:text-8xl">
          Threads
        </h1>
      </div>

      {/* Primary actions */}
      <div className="relative mb-12 flex items-center gap-6">
        <button
          onClick={() => navigate("/new?autostart=true")}
          className="flex flex-col items-center gap-2 group"
        >
          <span className="w-14 h-14 flex items-center justify-center rounded-full bg-gray-800 text-white group-hover:bg-gray-700 transition">
            <Mic size={22} />
          </span>
          <span className="text-xs text-gray-500 group-hover:text-gray-700 transition">New</span>
          {draftSummary && (
            <span className="text-[10px] font-medium text-amber-600 group-hover:text-amber-700 transition">
              Resume available
            </span>
          )}
        </button>

        <button
          onClick={() => navigate("/browse")}
          className="flex flex-col items-center gap-2 group"
        >
          <span className="w-14 h-14 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-200 text-gray-500 group-hover:text-gray-700 group-hover:border-gray-300 transition">
            <FolderOpen size={22} />
          </span>
          <span className="text-xs text-gray-500 group-hover:text-gray-700 transition">Browse</span>
        </button>
      </div>

      {/* Secondary actions */}
      <div className="relative flex items-center gap-5">
        <button
          type="button"
          onClick={() => showPendingFeatureToast("Import")}
          aria-disabled="true"
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/60 backdrop-blur-sm border border-gray-150 text-gray-300 group-hover:text-amber-600 group-hover:border-amber-300 transition">
            <FileUp size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-amber-700 transition">Import</span>
        </button>

        <button
          type="button"
          onClick={() => showPendingFeatureToast("Bookmarks")}
          aria-disabled="true"
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/60 backdrop-blur-sm border border-gray-150 text-gray-300 group-hover:text-amber-600 group-hover:border-amber-300 transition">
            <Bookmark size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-amber-700 transition">Bookmarks</span>
        </button>

        <button
          onClick={() => navigate("/cost-dashboard")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <BarChart3 size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Costs</span>
        </button>

        <button
          onClick={() => navigate("/settings")}
          className="flex flex-col items-center gap-1.5 group"
        >
          <span className="w-9 h-9 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-gray-150 text-gray-400 group-hover:text-gray-600 group-hover:border-gray-300 transition">
            <Settings size={16} />
          </span>
          <span className="text-[10px] text-gray-400 group-hover:text-gray-600 transition">Settings</span>
        </button>
      </div>

      {/* Service Status Indicators */}
      <div className="absolute bottom-8 left-8">
        <ServiceStatus />
      </div>

      {pendingFeatureToast && (
        <div className="pointer-events-none absolute bottom-8 right-8 z-20">
          <div className="rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-medium text-amber-800 shadow-sm backdrop-blur">
            {pendingFeatureToast}
          </div>
        </div>
      )}
    </div>
  );
}
