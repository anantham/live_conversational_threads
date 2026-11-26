import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, FolderOpen, FileAudio, FileText, Bookmark, BarChart3, Settings, Video } from "lucide-react";
import ServiceStatus from "../components/ServiceStatus";
import TooltipButton from "../components/TooltipButton";
import { loadLatestDraft, summarizeLocalDraft } from "../services/localDraftStore";
import { getAutostartOnNew } from "../utils/homeBehavior";
import { useMeetingsOpen } from "../hooks/useMeetingsOpen";

const action = "relative inline-flex items-center justify-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-700";
const neutral = "border-slate-200 bg-white/80 text-slate-600 hover:border-slate-400 hover:text-slate-900";
const primaryAction = `${action} size-20 sm:size-24`;
const secondaryAction = `${action} size-16 sm:size-18`;
const primaryIcon = "size-8 sm:size-9";
const secondaryIcon = "size-6 sm:size-7";
// A closed door stays visible and openable (earlier recordings live behind it), drawn quieter and labelled in words.
const closedNeutral = "border-dashed border-slate-300 bg-white/50 text-slate-500 hover:border-slate-400 hover:text-slate-700";

export default function Home() {
  const navigate = useNavigate();
  const [draftSummary, setDraftSummary] = useState(null);
  const [pendingFeatureToast, setPendingFeatureToast] = useState("");
  const meetClosed = useMeetingsOpen() === "closed";

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
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 py-16 font-sans">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.06),transparent_42%)]" />

      <h1 className="relative mb-10 text-center text-7xl font-semibold leading-none tracking-[-0.09em] text-slate-800 sm:mb-12 sm:text-8xl">
        Threads
      </h1>

      <nav aria-label="Home actions" className="relative flex flex-col items-center gap-8 sm:gap-10">
        <div className="flex flex-wrap justify-center gap-3 sm:gap-6">
          <TooltipButton compact align="center" aria-label="New recording"
            tooltip={draftSummary ? "New recording · Draft available" : "New recording"}
            onClick={() => navigate(getAutostartOnNew() ? "/new?autostart=true" : "/new")}
            className={`${primaryAction} border-slate-900 bg-slate-900 text-white hover:bg-slate-700`}>
            <Mic aria-hidden="true" className={primaryIcon} />
            {draftSummary && <span aria-hidden="true" className="absolute right-3 top-3 size-2.5 rounded-full bg-amber-400" />}
          </TooltipButton>
          <span className="relative inline-flex">
            <TooltipButton compact align="center"
              aria-label={meetClosed ? "Google Meet, closed for now" : "Join Google Meet"}
              tooltip={meetClosed ? "Google Meet is closed for now. Earlier recordings are still here." : "Join Google Meet"}
              onClick={() => navigate("/meeting")} className={`${primaryAction} ${meetClosed ? closedNeutral : neutral}`}>
              <Video aria-hidden="true" className={primaryIcon} />
            </TooltipButton>
            {meetClosed && <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-xs text-slate-600">Closed for now</span>}
          </span>
          <TooltipButton compact align="center" aria-label="Browse library" tooltip="Browse library"
            onClick={() => navigate("/browse")} className={`${primaryAction} ${neutral}`}>
            <FolderOpen aria-hidden="true" className={primaryIcon} />
          </TooltipButton>
        </div>

        <div className="flex flex-wrap justify-center gap-2 sm:gap-4">
          {import.meta.env.VITE_SITES_MODE === "true" && (
            <TooltipButton compact align="center" aria-label="Import transcript" tooltip="Import transcript"
              onClick={() => navigate("/import-transcript")} className={`${secondaryAction} ${neutral}`}>
              <FileText aria-hidden="true" className={secondaryIcon} />
            </TooltipButton>
          )}
          <TooltipButton compact align="center" aria-label="Import audio" tooltip="Import audio"
            onClick={() => navigate(import.meta.env.VITE_SITES_MODE === "true" ? "/import-audio" : "/new")}
            className={`${secondaryAction} ${neutral}`}>
            <FileAudio aria-hidden="true" className={secondaryIcon} />
          </TooltipButton>
          {import.meta.env.VITE_SITES_MODE !== "true" && (
            <TooltipButton compact align="center" aria-label="Bookmarks" tooltip="Bookmarks" aria-disabled="true"
              onClick={() => showPendingFeatureToast("Bookmarks")} className={`${secondaryAction} border-slate-200 bg-white/60 text-slate-400`}>
              <Bookmark aria-hidden="true" className={secondaryIcon} />
            </TooltipButton>
          )}
          <TooltipButton compact align="center" aria-label="Costs" tooltip="Costs"
            onClick={() => navigate("/cost-dashboard")} className={`${secondaryAction} ${neutral}`}>
            <BarChart3 aria-hidden="true" className={secondaryIcon} />
          </TooltipButton>
          <TooltipButton compact align="center" aria-label="Settings" tooltip="Settings"
            onClick={() => navigate("/settings")} className={`${secondaryAction} ${neutral}`}>
            <Settings aria-hidden="true" className={secondaryIcon} />
          </TooltipButton>
        </div>
      </nav>

      {/* Service Status Indicators */}
      {import.meta.env.VITE_SITES_MODE !== "true" && (
        <div className="absolute bottom-8 left-8">
          <ServiceStatus />
        </div>
      )}

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
