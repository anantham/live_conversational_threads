import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, ArrowLeft, CloudUpload, RotateCw, Trash2 } from "lucide-react";
import { usePrivateFiles } from "../hooks/usePrivateFiles";
import { formatBytes, validatePrivateFile } from "../services/privateFiles";
import { PRIVATE_CONVERSATION_FIXTURE } from "../services/cloud/privateConversationFixture";
import PrivateRetentionNotice from "../components/PrivateRetentionNotice";
import PrivateConversation from "./PrivateConversation";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50";
const SYNTHETIC_FILE = { filename: "lct-storage-check.txt", contentType: "text/plain", text: "LCT synthetic private storage fixture.\nNo personal data.\n" };

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Date unavailable" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PrivateFiles() {
  const { status, files, next, guest, listed, error, setError, activity, elapsed, run, list, cancel, refresh } = usePrivateFiles();
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [openFile, setOpenFile] = useState(null);
  const input = useRef(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const available = status?.enabled === true && status?.configured === true;
  const selectedError = selected && available ? validatePrivateFile(selected, status.limits) : "";

  async function refreshAfterWrite(preserveError) {
    if (alive.current) await list(null, false, preserveError);
  }

  async function upload(fixture = null) {
    const file = fixture ? new File([fixture.text], fixture.filename, { type: fixture.contentType }) : selected;
    if (!file || (!fixture && selectedError) || activity) return;
    setNotice("");
    setError("");
    const result = await run("upload", "/api/cloud/files", { method: "POST", file });
    if (!alive.current) return;
    if (result.data) {
      setSelected(null);
      if (input.current) input.current.value = "";
      setNotice("File saved privately. It is available to download.");
    } else if (result.outcome === "timeout" || result.outcome === "cancelled") {
      setError("Upload outcome is uncertain. Check the refreshed list before choosing to retry; this file may already have been saved.");
    } else setError(result.error.message);
    await refreshAfterWrite(!result.data);
  }

  async function remove(id) {
    if (activity) return;
    setConfirmId(null);
    setNotice("");
    setError("");
    const result = await run("delete", `/api/cloud/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!alive.current) return;
    if (result.data) setNotice("Private file permanently deleted.");
    else if (result.outcome === "timeout" || result.outcome === "cancelled") setError("Deletion outcome is uncertain. Refresh the list before retrying.");
    else setError(result.error.message);
    await refreshAfterWrite(!result.data);
  }

  async function recover(id) {
    if (activity) return;
    setError("");
    setNotice("");
    const result = await run("recover", `/api/cloud/files/${encodeURIComponent(id)}/reconcile`, { method: "POST" });
    if (!alive.current) return;
    if (result.data) setNotice("Unfinished upload checked. The list has been refreshed.");
    else setError(result.outcome === "timeout" || result.outcome === "cancelled" ? "Recovery outcome is uncertain. Refresh the list before retrying." : result.error.message);
    await refreshAfterWrite(!result.data);
  }

  const canWrite = available && listed && !guest && !activity;
  if (openFile) return <PrivateConversation key={openFile.id} file={openFile} onClose={() => setOpenFile(null)} />;
  return (
    <main className="min-h-dvh bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-40 pt-8 font-sans text-slate-800 sm:px-8 sm:pt-12">
      <div className="mx-auto max-w-3xl">
        <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"><ArrowLeft size={16} /> Home</Link>
        <header className="mt-8 border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Private cloud files</h1>
          <p className="mt-3 max-w-[65ch] text-sm leading-6 text-slate-600">Files here belong to your signed-in account. Browser-local files stay on this device unless you choose to upload one.</p>
        </header>

        {activity && <div role="status" aria-live="polite" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700"><span>{({ status: "Checking storage", list: "Loading private files", upload: "Uploading file", delete: "Deleting file", recover: "Recovering unfinished upload" })[activity]} · {elapsed}s elapsed · Time remaining unknown</span><button type="button" onClick={cancel} className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700">Cancel</button></div>}
        {error && <div role="alert" className="mt-5 rounded-lg bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{error}</div>}
        {notice && <p role="status" className="mt-5 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p>}

        {!status && !activity && <button type="button" className={`${button} mt-5`} onClick={refresh}>Retry storage status</button>}
        {status && !available && <section className="mt-8 rounded-xl bg-white p-6 shadow-[0_8px_28px_rgba(15,23,42,0.08)]"><h2 className="text-lg font-semibold">Private storage is {status.enabled ? "unavailable" : "inactive"}</h2><p className="mt-2 text-sm leading-6 text-slate-600">Cloud uploads are not available yet. Your browser-local files remain available in Browse.</p><div className="mt-5 flex flex-wrap gap-3"><Link className={button} to="/browse">Browse local files</Link><button type="button" className={button} onClick={refresh}>Check again</button></div></section>}
        {available && !listed && !activity && <button type="button" className={`${button} mt-5`} onClick={() => list()}>Retry private file list</button>}
        {available && guest && <section className="mt-8 rounded-xl bg-white p-6 shadow-[0_8px_28px_rgba(15,23,42,0.08)]"><h2 className="text-lg font-semibold">Sign in to see your files</h2><p className="mt-2 text-sm leading-6 text-slate-600">Private files are visible only to the account that saved them. Public browsing remains available.</p><a className={`${primary} mt-5`} href="#site-access">Choose how to sign in</a></section>}

        {available && listed && !guest && <>
          <section className="mt-8 rounded-xl bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.08)] sm:p-6" aria-labelledby="upload-heading">
            <div className="flex items-center gap-3"><CloudUpload size={21} aria-hidden="true" /><h2 id="upload-heading" className="text-lg font-semibold">Upload a private file</h2></div>
            {status.synthetic_only ? <p className="mt-2 text-sm leading-6 text-slate-600">These checks save fixed files with no personal data. The test conversation opens as a map. Personal uploads are not active yet.</p> : <p className="mt-2 text-sm leading-6 text-slate-600">Choose a file up to {formatBytes(status.limits.maxFileBytes)}. Uploading stores a separate cloud copy for this account.</p>}
            <PrivateRetentionNotice id="private-file-retention" />
            {status.synthetic_only ? <div className="mt-5 flex flex-wrap gap-3"><button type="button" onClick={() => upload(SYNTHETIC_FILE)} disabled={!canWrite} aria-describedby="private-file-retention" className={primary}>Run private storage check</button><button type="button" onClick={() => upload(PRIVATE_CONVERSATION_FIXTURE)} disabled={!canWrite} aria-describedby="private-file-retention" className={button}>Save a test conversation</button></div> : <>
            <label htmlFor="private-file" className="mt-5 block text-sm font-medium">File to upload</label>
            <input id="private-file" ref={input} type="file" disabled={Boolean(activity)} onChange={(event) => { setSelected(event.target.files?.[0] || null); setError(""); }} className="mt-2 block w-full max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" />
            {selectedError && <p role="alert" className="mt-2 text-sm text-rose-700">{selectedError}</p>}
            <button type="button" onClick={() => upload()} disabled={!selected || Boolean(selectedError) || !canWrite} aria-describedby="private-file-retention" className={`${primary} mt-4`}>Save file privately</button></>}
          </section>

          <section className="mt-10" aria-labelledby="files-heading">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="files-heading" className="text-xl font-semibold">Your files</h2><button type="button" className={button} onClick={() => list()} disabled={Boolean(activity)}><RotateCw size={16} aria-hidden="true" /> Refresh list</button></div>
            {!activity && files.length === 0 && <p className="mt-5 text-sm text-slate-600">No private cloud files here yet.</p>}
            <ul className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
              {files.map((file) => <li key={file.id} className="py-5"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><p className="break-words font-medium">{file.title || file.filename}</p><p className="mt-1 text-xs text-slate-600">{file.kind} · {formatBytes(file.byte_size)} · {dateLabel(file.created_at)} · Private · {file.state}</p></div><div className="flex flex-wrap gap-2">{file.state === "ready" && file.kind === "threads" && <button type="button" className={button} disabled={Boolean(activity)} onClick={() => setOpenFile(file)}>Open conversation</button>}{file.state === "ready" && <a className={button} href={`/api/cloud/files/${encodeURIComponent(file.id)}/content`} download><ArrowDownToLine size={16} aria-hidden="true" /> Download</a>}{file.state === "staging" && <button className={button} type="button" disabled={Boolean(activity)} onClick={() => recover(file.id)}>Recover unfinished upload</button>}<button className={button} type="button" disabled={Boolean(activity)} onClick={() => setConfirmId(file.id)}><Trash2 size={16} aria-hidden="true" /> Delete</button></div></div>{confirmId === file.id && <div className="mt-4 rounded-lg bg-rose-50 p-4 text-sm text-rose-900"><p>Permanently delete “{file.filename}”? This cannot be undone.</p><div className="mt-3 flex flex-wrap gap-2"><button className={primary} type="button" disabled={Boolean(activity)} onClick={() => remove(file.id)}>Delete permanently</button><button className={button} type="button" onClick={() => setConfirmId(null)}>Keep file</button></div></div>}</li>)}
            </ul>
            {next && <button type="button" className={`${button} mt-5`} disabled={Boolean(activity)} onClick={() => list(next, true)}>Load more files</button>}
          </section>
        </>}
      </div>
    </main>
  );
}
