import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { FolderOpen, ShieldCheck } from "lucide-react";

import {
  driveThreadsSourceName,
  fetchDriveThreadsArtifact,
  loadGoogleIdentityServices,
  normalizeDriveFileId,
  requestDriveAccessToken,
} from "../../services/googleDriveThreads";

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID || import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "";

export default function DriveThreadsGate({
  fileId,
  onArtifact,
  clientId = GOOGLE_CLIENT_ID,
  prepareAuthorization = loadGoogleIdentityServices,
  authorize = requestDriveAccessToken,
  fetchArtifact = fetchDriveThreadsArtifact,
}) {
  const normalizedId = normalizeDriveFileId(fileId);
  const [status, setStatus] = useState("ready");
  const [error, setError] = useState("");
  const [authorizationReady, setAuthorizationReady] = useState(false);
  const [preparationAttempt, setPreparationAttempt] = useState(0);

  useEffect(() => {
    if (!normalizedId || !clientId) return undefined;
    let cancelled = false;
    setStatus("loading_google");
    setError("");
    void prepareAuthorization()
      .then(() => {
        if (cancelled) return;
        setAuthorizationReady(true);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setStatus("error");
        setError(String(loadError?.message || loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, normalizedId, preparationAttempt, prepareAuthorization]);

  const openFromDrive = async () => {
    setStatus("authorizing");
    setError("");
    try {
      const accessToken = await authorize(clientId);
      setStatus("downloading");
      const artifact = await fetchArtifact(normalizedId, accessToken);
      onArtifact(artifact, { sourceName: driveThreadsSourceName() });
    } catch (openError) {
      setStatus("error");
      setError(String(openError?.message || openError));
    }
  };

  const busy = status === "loading_google" || status === "authorizing" || status === "downloading";
  const preparationFailed = status === "error" && !authorizationReady;
  const buttonLabel = status === "loading_google"
    ? "Preparing secure Google sign-in…"
    : status === "authorizing"
    ? "Waiting for Google…"
    : status === "downloading"
      ? "Opening conversation map…"
      : status === "error"
        ? preparationFailed
          ? "Retry Google sign-in"
          : "Try another Google account"
        : "Continue with Google";

  const retryPreparation = () => {
    setError("");
    setStatus("loading_google");
    setPreparationAttempt((attempt) => attempt + 1);
  };

  return (
    <main className="flex min-h-[100dvh] w-full items-center justify-center bg-[#faf8f3] px-5 py-10 font-sans">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-[0_18px_55px_rgba(51,45,35,0.08)] sm:px-9">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <FolderOpen aria-hidden="true" size={23} strokeWidth={1.8} />
        </div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
          Shared conversation map
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-slate-900">
          Open this conversation in Threads
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Sign in with the Google account this file was shared with. Google checks the Drive
          permission, then the map opens here and is remembered only in this browser.
        </p>

        {!normalizedId && (
          <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            This Drive-backed Threads link is invalid. Ask the sender for a fresh link.
          </p>
        )}
        {normalizedId && !clientId && (
          <p role="alert" className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Drive-backed links are not configured on this deployment yet. Ask the sender for
            the <span className="font-mono">.threads</span> file directly.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm leading-5 text-red-700">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={
            !normalizedId
            || !clientId
            || busy
            || (!authorizationReady && !preparationFailed)
          }
          onClick={preparationFailed ? retryPreparation : openFromDrive}
          className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && (
            <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {buttonLabel}
        </button>

        <div className="mt-5 flex items-start gap-2 border-t border-slate-100 pt-5 text-xs leading-5 text-slate-500">
          <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-600" size={16} />
          <p>
            LCT requests access only to files opened with this app. The temporary Google token
            stays in memory and is never placed in the link or saved to browser storage.
          </p>
        </div>
      </section>
    </main>
  );
}

DriveThreadsGate.propTypes = {
  fileId: PropTypes.string.isRequired,
  onArtifact: PropTypes.func.isRequired,
  clientId: PropTypes.string,
  prepareAuthorization: PropTypes.func,
  authorize: PropTypes.func,
  fetchArtifact: PropTypes.func,
};
