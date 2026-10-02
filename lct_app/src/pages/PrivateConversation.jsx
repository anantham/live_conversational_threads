import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useCloudTask } from "../hooks/useCloudTask";
import PublicTaskStatus from "../components/PublicTaskStatus";
import { loadPrivateThreads } from "../services/privateThreads";
import ThreadsViewer from "./ThreadsViewer";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:opacity-50";

export default function PrivateConversation({ file, onClose }) {
  const task = useCloudTask("private-conversation");
  const [bundle, setBundle] = useState(null), [failure, setFailure] = useState(null), [attempt, setAttempt] = useState(0);
  const { run, cancel } = task;
  useEffect(() => {
    let stopped = false;
    setBundle(null); setFailure(null);
    void run("load", signal => loadPrivateThreads(file, { signal })).then(result => {
      if (stopped) return;
      if (result.data) setBundle(result.data);
      else setFailure({ status: result.error?.status, message: result.outcome === "timeout"
        ? "Loading took too long. Retry this private conversation or return to your files."
        : result.outcome === "cancelled" ? "Loading cancelled. You can retry or return to your files."
          : result.error?.message || "Could not open this private conversation. Retry or return to your files." });
    });
    return () => { stopped = true; cancel(); };
  }, [file, attempt, run, cancel]);

  if (bundle) return <ThreadsViewer privateBundle={bundle} onPrivateClose={onClose} />;
  return <main className="min-h-dvh bg-[#fdfdfb] px-4 pb-40 pt-8 font-sans text-slate-800 sm:px-8 sm:pt-12">
    <div className="mx-auto max-w-2xl">
      <button type="button" className={control} onClick={onClose}>Back to private files</button>
      <h1 className="mt-8 text-2xl font-semibold">Private conversation</h1>
      <p className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Opening a cloud copy for this account. The map stays in this view.</p>
      <PublicTaskStatus {...task} loadingLabel="Loading private conversation" />
      {failure && <p role="alert" className="my-5 text-sm leading-6 text-rose-800">{failure.message}</p>}
      {failure?.status === 401 && <a href="/signin-with-chatgpt?return_to=%2Fprivate-files" target="_top" className={`${control} mr-3`}>Sign in with ChatGPT</a>}
      {!task.activity && <button type="button" className={control} onClick={() => setAttempt(value => value + 1)}>Retry loading</button>}
    </div>
  </main>;
}

PrivateConversation.propTypes = { file: PropTypes.object.isRequired, onClose: PropTypes.func.isRequired };
