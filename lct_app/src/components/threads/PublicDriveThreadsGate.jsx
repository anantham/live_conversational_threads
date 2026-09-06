import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import { fetchPublicDriveThreadsArtifact } from "../../services/publicDriveThreads";

export default function PublicDriveThreadsGate({ fileId, onArtifact, onCancel, loadArtifact = fetchPublicDriveThreadsArtifact }) {
  const receive = useRef(onArtifact);
  receive.current = onArtifact;
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void loadArtifact(fileId, { signal: controller.signal }).then((artifact) => {
      if (!controller.signal.aborted) receive.current(artifact, { sourceName: "Public Google Drive", driveFileId: fileId });
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message || "This public conversation could not be opened.");
    });
    return () => controller.abort();
  }, [fileId, attempt, loadArtifact]);
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#faf8f3] px-5 font-sans">
      <section className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-slate-700">
        <h1 className="text-lg font-semibold">{error ? "Could not open this conversation" : "Opening the conversation…"}</h1>
        {error ? <>
          <p role="alert" className="mt-3 text-sm leading-6">{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-5 min-h-11 rounded-lg bg-slate-900 px-4 text-sm text-white">Try again</button>
          <a className="ml-4 text-sm text-amber-700" href={`/view?driveFile=${encodeURIComponent(fileId)}`}>Open with Google instead</a>
        </> : <p role="status" className="mt-3 text-sm text-slate-500">Loading the public file from Drive. No sign-in needed.</p>}
        {onCancel && <button type="button" onClick={onCancel} className="mt-4 block min-h-11 text-sm">Back to saved map</button>}
      </section>
    </main>
  );
}
PublicDriveThreadsGate.propTypes = { fileId: PropTypes.string.isRequired, onArtifact: PropTypes.func.isRequired, onCancel: PropTypes.func, loadArtifact: PropTypes.func };
