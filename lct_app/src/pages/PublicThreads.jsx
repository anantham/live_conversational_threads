import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCloudTask } from "../hooks/useCloudTask";
import PublicTaskStatus from "../components/PublicTaskStatus";
import { PUBLIC_API, downloadRemovalKey, newPublication, preparePublicFile, publicRequest, removalKeys, saveRemovalKey } from "../services/publicThreads";

const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:opacity-50";
const primary = button + " !bg-slate-800 !text-white hover:!bg-slate-700";

export default function PublicThreads() {
  const task = useCloudTask(), { run } = task;
  const [items, setItems] = useState([]), [next, setNext] = useState(null), [status, setStatus] = useState(null);
  const [selected, setSelected] = useState(null), [consent, setConsent] = useState(false), [attempted, setAttempted] = useState(false);
  const [keys, setKeys] = useState(removalKeys), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState(null), [recoveryId, setRecoveryId] = useState(""), [recoveryKey, setRecoveryKey] = useState("");
  const [shownKeyId, setShownKeyId] = useState(null);
  const alive = useRef(true), input = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function list(cursor = null, append = false) {
    const query = cursor ? `?before=${encodeURIComponent(cursor.before)}&before_id=${encodeURIComponent(cursor.before_id)}` : "";
    const result = await run("list", async signal => {
      const configuration = await publicRequest(`${PUBLIC_API}/status`, { signal });
      if (!configuration.enabled || !configuration.configured) return { status: configuration, items: [], next: null };
      const data = await publicRequest(PUBLIC_API + query, { signal });
      if (!Array.isArray(data.items)) throw new Error("The public library returned no conversation list. Retry.");
      return { ...data, status: configuration };
    });
    if (!alive.current) return;
    if (result.data) { setStatus(result.data.status); setItems(old => append ? [...old, ...result.data.items] : result.data.items); setNext(result.data.next); }
    else setError(result.outcome === "timeout" ? "The public library took too long. Refresh to retry." : result.outcome === "cancelled" ? "Loading cancelled. Refresh to retry." : result.error.message);
  }

  useEffect(() => {
    let stopped = false;
    void run("list", async signal => {
      const configuration = await publicRequest(`${PUBLIC_API}/status`, { signal });
      if (!configuration.enabled || !configuration.configured) return { status: configuration, items: [], next: null };
      const data = await publicRequest(PUBLIC_API, { signal });
      if (!Array.isArray(data.items)) throw new Error("The public library returned no conversation list. Retry.");
      return { ...data, status: configuration };
    }).then(result => {
      if (stopped) return;
      if (result.data) { setStatus(result.data.status); setItems(result.data.items); setNext(result.data.next); }
      else setError(result.outcome === "timeout" ? "The public library took too long. Refresh to retry." : result.outcome === "cancelled" ? "Loading cancelled. Refresh to retry." : result.error.message);
    });
    return () => { stopped = true; };
  }, [run]);

  async function choose(file) {
    setSelected(null); setConsent(false); setAttempted(false); setError(""); setNotice("");
    const result = await run("prepare", () => preparePublicFile(file));
    if (!alive.current) return;
    if (result.data) setSelected({ ...result.data, capability: newPublication() });
    else setError(result.outcome === "cancelled" || result.outcome === "timeout" ? "File preparation stopped. Choose the file again." : result.error.message);
  }

  async function publish() {
    if (!selected || !consent || task.activity) return;
    setError(""); setNotice("");
    try { saveRemovalKey(selected.capability); setKeys(removalKeys()); }
    catch (cause) { setError(cause.message); return; }
    setAttempted(true);
    const result = await run("publish", signal => publicRequest(`${PUBLIC_API}/${selected.capability.id}`, { method: "POST", capability: selected.capability, payload: selected.payload, signal }));
    if (!alive.current) return;
    if (result.data) { setNotice("Public copy saved. Anyone can browse and download it. Keep your removal key."); setSelected(null); setConsent(false); if (input.current) input.current.value = ""; }
    else setError(result.outcome === "cancelled" || result.outcome === "timeout" ? "Publication outcome is uncertain. Your removal key is saved. Refresh the list or retry this same publication; it will not create a duplicate." : result.error.message);
    await list();
  }

  async function remove(capability) {
    setConfirmation(null); setError(""); setNotice("");
    const result = await run("remove", signal => publicRequest(`${PUBLIC_API}/${capability.id}`, { method: "DELETE", capability, signal }));
    if (!alive.current) return;
    if (result.data) setNotice("Public copy removed from the live library. Previously downloaded copies cannot be recalled.");
    else setError(result.outcome === "cancelled" || result.outcome === "timeout" ? "Removal outcome is uncertain. Refresh or retry removal with the same key." : result.error.message);
    await list();
  }

  function restoreKey() {
    setError("");
    try { saveRemovalKey({ id: recoveryId.trim(), key: recoveryKey.trim() }); setKeys(removalKeys()); setRecoveryKey(""); setNotice("Removal key saved on this device."); }
    catch (cause) { setError(cause.message); }
  }

  const available = status?.enabled === true && status?.configured === true;
  return <main className="min-h-dvh bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-52 pt-8 font-sans text-slate-800 sm:px-8">
    <div className="mx-auto max-w-3xl"><nav className="flex flex-wrap gap-5 text-sm"><Link className="inline-flex min-h-11 items-center underline" to="/">Home</Link><Link className="inline-flex min-h-11 items-center underline" to="/browse">On this device</Link><Link className="inline-flex min-h-11 items-center underline" to="/private-files">Private files</Link></nav>
      <header className="mt-6 border-b border-slate-200 pb-6"><p className="text-xs uppercase tracking-[0.22em] text-slate-500">Open to everyone</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Public conversations</h1><p className="mt-3 text-sm leading-6 text-slate-600">Browse, download and publish a public conversation without signing in. Private files use your ChatGPT account. Opening a file locally never publishes it.</p></header>
      <PublicTaskStatus {...task} />{error && <p role="alert" className="my-5 rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-800">{error}</p>}{notice && <p role="status" className="my-5 rounded-lg bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">{notice}</p>}
      {status && !available && <p className="my-6 text-sm text-slate-600">Public publication is not activated yet. You can still open files on this device.</p>}
      {available && <section aria-labelledby="publish-title" className="mt-8 rounded-xl bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.08)] sm:p-6"><h2 id="publish-title" className="text-xl font-semibold">Publish a public copy</h2><p className="mt-2 text-sm leading-6 text-slate-600">Choose a .threads map up to 512 KiB. Preview limits: 2,000 nodes, 8,000 edges, 20 publications per 24 hours across this Site and 10 seconds between publications. The shared preview storage has 20 MiB and 200 lifetime creations.</p><label className="mt-5 block text-sm font-medium" htmlFor="public-file">Prepare a file on this device</label><input ref={input} id="public-file" type="file" accept=".threads" disabled={Boolean(task.activity)} onChange={event => { const file = event.target.files?.[0]; if (file) void choose(file); }} className="mt-2 block w-full rounded-lg border border-slate-300 p-2 text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium" />
        {selected && <div className="mt-5 border-t border-slate-200 pt-5"><h3 className="break-words font-semibold">{selected.title}</h3><p className="mt-1 text-sm text-slate-600">{selected.count} nodes · Entire file, including transcript, names, source links and metadata</p><details className="mt-3"><summary className="min-h-11 cursor-pointer text-sm underline">Review everything that will become public</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-xs">{JSON.stringify(JSON.parse(selected.payload), null, 2)}</pre></details><label className="mt-4 flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={consent} disabled={Boolean(task.activity)} onChange={event => setConsent(event.target.checked)} className="mt-1 h-5 w-5 shrink-0" />I have permission to publish the whole file, including everyone’s words. Anyone can browse and download it.</label><button type="button" className={`${primary} mt-4`} disabled={!consent || Boolean(task.activity)} onClick={publish}>{attempted ? "Retry same publication" : "Publish public copy"}</button></div>}
      </section>}
      <section className="mt-10" aria-labelledby="public-list-title"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="public-list-title" className="text-xl font-semibold">Shared library</h2><button type="button" className={button} disabled={Boolean(task.activity)} onClick={() => { setError(""); void list(); }}>Refresh public library</button></div>{available && !task.activity && items.length === 0 && <p className="mt-5 text-sm text-slate-600">No public conversations yet.</p>}<ul className="mt-4 divide-y divide-slate-200 border-y border-slate-200">{items.map(item => {
        const capability = keys.find(key => key.id === item.id);
        return <li key={item.id} className="py-5"><Link className="inline-flex min-h-11 max-w-full items-center break-words text-lg font-medium underline-offset-4 hover:underline" to={`/public/${encodeURIComponent(item.id)}`}>{item.title}</Link><p className="text-xs text-slate-600">Public · {item.node_count} nodes · {Math.ceil(item.byte_size / 1024)} KiB</p><div className="mt-3 flex flex-wrap gap-2"><a className={button} href={`${PUBLIC_API}/${encodeURIComponent(item.id)}/content`} download>Download .threads</a>{capability && <><button type="button" className={button} onClick={() => downloadRemovalKey(capability)}>Download removal key</button><button type="button" className={button} disabled={Boolean(task.activity)} onClick={() => setConfirmation(capability)}>Remove public copy</button></>}</div>{capability && <details className="mt-3"><summary className="min-h-11 cursor-pointer text-sm underline">View removal details</summary><p className="mt-2 text-sm leading-6 text-slate-600">If downloading is unavailable, keep these two values somewhere safe. Anyone with the key can remove this public copy. They are stored only on this device; do not share the key in your public link.</p><label htmlFor={`saved-id-${item.id}`} className="mt-3 block text-sm">Saved publication ID</label><input id={`saved-id-${item.id}`} readOnly value={capability.id} className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" /><label htmlFor={`saved-key-${item.id}`} className="mt-3 block text-sm">Saved removal key</label><input id={`saved-key-${item.id}`} readOnly autoComplete="off" type={shownKeyId === item.id ? "text" : "password"} value={capability.key} className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" /><button type="button" className={`${button} mt-3`} onClick={() => setShownKeyId(value => value === item.id ? null : item.id)}>{shownKeyId === item.id ? "Hide removal key" : "Show removal key"}</button></details>}</li>;
      })}</ul>{next && <button type="button" className={`${button} mt-5`} disabled={Boolean(task.activity)} onClick={() => list(next, true)}>Load more public conversations</button>}</section>
      <details className="mt-10 rounded-xl border border-slate-200 p-5"><summary className="min-h-11 cursor-pointer font-medium">Use a saved removal key</summary><p className="mt-2 text-sm leading-6 text-slate-600">Only this key can remove your public copy. Keep its download somewhere safe. Removing it from this Site cannot recall other people’s downloads or immediately erase provider backups.</p><label className="mt-4 block text-sm" htmlFor="removal-id">Publication ID</label><input id="removal-id" value={recoveryId} maxLength={36} onChange={event => setRecoveryId(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2" /><label className="mt-3 block text-sm" htmlFor="removal-key">Removal key</label><input id="removal-key" type="password" autoComplete="off" value={recoveryKey} maxLength={64} onChange={event => setRecoveryKey(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2" /><button type="button" className={`${button} mt-4`} onClick={restoreKey}>Save removal key on this device</button>{keys.filter(key => key.id === recoveryId.trim()).map(key => <button key={key.id} type="button" className={`${button} ml-2 mt-4`} disabled={Boolean(task.activity)} onClick={() => setConfirmation(key)}>Remove using this key</button>)}</details>
      {confirmation && <section aria-label="Confirm public removal" className="mt-6 rounded-xl bg-rose-50 p-5 text-sm text-rose-900"><p>Remove this public copy from the live library? This cannot restore or recall downloaded copies.</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className={primary} disabled={Boolean(task.activity)} onClick={() => remove(confirmation)}>Confirm public removal</button><button type="button" className={button} onClick={() => setConfirmation(null)}>Keep public copy</button></div></section>}
    </div>
  </main>;
}
