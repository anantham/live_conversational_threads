import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { useCloudTask } from "../hooks/useCloudTask";
import PublicTaskStatus from "../components/PublicTaskStatus";
import { PUBLIC_API, publicRequest } from "../services/publicThreads";
import { validateThreadsArtifact } from "../services/threadsArtifact";

export default function PublicThreadsLoader({ id, onArtifact }) {
  const task = useCloudTask();
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const { run } = task;
  useEffect(() => {
    let stopped = false;
    setError("");
    void run("load", signal => publicRequest(`${PUBLIC_API}/${encodeURIComponent(id)}/content`, { signal }).then(validateThreadsArtifact)).then(result => {
      if (stopped) return;
      if (result.data) onArtifact(result.data);
      else setError(result.outcome === "timeout" ? "Loading took too long. Retry this public conversation." : result.outcome === "cancelled" ? "Loading cancelled. You can retry or return to the library." : result.error.message);
    });
    return () => { stopped = true; };
  }, [id, attempt, onArtifact, run]);
  return <main className="min-h-dvh bg-[#fafafa] p-6 pb-48 font-sans text-slate-800"><div className="mx-auto max-w-2xl pt-12"><Link to="/public" className="inline-flex min-h-11 items-center text-sm underline">Public library</Link><h1 className="mt-6 text-2xl font-semibold">Public conversation</h1><p className="mt-3 text-sm text-slate-600">Anyone can open this public copy. It won’t be added to this device’s private library.</p><PublicTaskStatus {...task} />{error && <p role="alert" className="my-5 text-sm text-rose-800">{error}</p>}{!task.activity && <button type="button" className="min-h-11 rounded-lg border border-slate-300 px-4 py-2" onClick={() => setAttempt(value => value + 1)}>Retry loading</button>}</div></main>;
}

PublicThreadsLoader.propTypes = { id: PropTypes.string.isRequired, onArtifact: PropTypes.func.isRequired };
