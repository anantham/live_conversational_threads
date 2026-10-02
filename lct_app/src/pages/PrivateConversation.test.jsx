// @vitest-environment jsdom
// Intent: tests/intent/sites-private-conversation.md. Fixed nonpersonal artifacts only.
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { PRIVATE_CONVERSATION_FIXTURE } from "../services/cloud/privateConversationFixture";

vi.mock("./ThreadsViewer", () => ({ default: ({ privateBundle, onPrivateClose }) => <div>{privateBundle.conversation_title}<button onClick={onPrivateClose}>Close private conversation</button></div> }));
import PrivateConversation from "./PrivateConversation";

const id = "00000000-0000-4000-8000-000000000001";
const bytes = new TextEncoder().encode(PRIVATE_CONVERSATION_FIXTURE.text);
// Node's native Response streams and jsdom use different typed-array realms.
// Align the harness with its native fetch body without weakening browser validation.
const FetchUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
const file = { id, filename: PRIVATE_CONVERSATION_FIXTURE.filename, byte_size: bytes.length, kind: "threads", state: "ready" };
const response = () => new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
let root, host, close;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); close = vi.fn();
  vi.stubGlobal("Uint8Array", FetchUint8Array);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const mount = (strict = false) => act(async () => root.render(strict ? <StrictMode><PrivateConversation file={file} onClose={close} /></StrictMode> : <PrivateConversation file={file} onClose={close} />));
const click = label => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label).click());
const timing = () => JSON.parse(localStorage.getItem("lct.private_conversation_timing.v1") || "[]");

it("opens the exact owner content once, closes through the private list callback and keeps timing payload-free and separately grouped", async () => {
  const old = Array.from({ length: 14 }, () => ({ stage: "load", durationMs: 1, outcome: "success", retryCount: 0, filename: "discarded-field" }));
  localStorage.setItem("lct.private_conversation_timing.v1", JSON.stringify(old));
  localStorage.setItem("lct.public_tasks_timing.v1", "[]");
  const originalUrl = window.location.href;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
  await mount();
  expect(host.textContent).toContain("Synthetic private conversation check");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(`/api/cloud/files/${id}/content`);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
  expect(window.location.href).toBe(originalUrl);
  expect(localStorage.getItem("lct.public_tasks_timing.v1")).toBe("[]");
  expect(timing()).toHaveLength(12);
  expect(timing().every(item => Object.keys(item).sort().join() === "durationMs,outcome,retryCount,stage")).toBe(true);
  expect(JSON.stringify(timing())).not.toMatch(/synthetic|storage-check|00000000|discarded-field/i);
  await click("Close private conversation"); expect(close).toHaveBeenCalledTimes(1);
});

it("recovers from expired identity only through explicit same-site sign-in or same-file retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("sensitive upstream body", { status: 401 })).mockResolvedValueOnce(response()));
  await mount();
  expect(host.textContent).toContain("Sign in to open this private conversation");
  expect(host.textContent).not.toContain("sensitive upstream body");
  const signIn = [...host.querySelectorAll("a")].find(link => link.textContent === "Choose how to sign in");
  expect(signIn.getAttribute("href")).toBe("#site-access");
  expect(signIn.target).toBe(""); expect(signIn.href).not.toContain(id);
  await click("Retry loading");
  expect(host.textContent).toContain("Synthetic private conversation check");
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([`/api/cloud/files/${id}/content`, `/api/cloud/files/${id}/content`]);
});

it.each([[404, "unavailable to this account"], [409, "still being stored"], [503, "Private storage is unavailable"]])("shows safe HTTP %s failure with return and retry, never falling back to another source", async (status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private backend detail", { status })));
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain(message);
  expect(host.textContent).not.toContain("private backend detail");
  expect(fetch).toHaveBeenCalledTimes(1);
  await click("Back to private files"); expect(close).toHaveBeenCalledTimes(1);
});

it("rejects malformed private content and offers recovery without rendering it", async () => {
  const wrong = new TextEncoder().encode("private-invalid-json");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wrong, { headers: { "content-type": "application/json" } })));
  await act(async () => root.render(<PrivateConversation file={{ ...file, byte_size: wrong.length }} onClose={close} />));
  expect(host.textContent).toContain("invalid or uses an unsupported");
  expect(host.textContent).not.toContain("private-invalid-json");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("shows stage/elapsed/unknown remaining, times out a stalled fetch and retries deliberately", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response()));
  await mount(); await act(async () => vi.advanceTimersByTime(2000));
  expect(host.querySelector('[role="status"]').textContent).toContain("Loading private conversation · 2s elapsed · Time remaining unknown");
  await act(async () => vi.advanceTimersByTime(28000));
  expect(host.textContent).toContain("Loading took too long");
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await click("Retry loading");
  expect(host.textContent).toContain("Synthetic private conversation check");
  expect(timing().map(({ outcome, retryCount }) => ({ outcome, retryCount }))).toEqual([{ outcome: "timeout", retryCount: 0 }, { outcome: "success", retryCount: 1 }]);
});

it("cancels a stalled fetch, discards its late response and can retry without stale content", async () => {
  let resolveFirst;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce(response()));
  await mount(); await click("Cancel");
  expect(host.textContent).toContain("Loading cancelled");
  await act(async () => resolveFirst(response()));
  expect(host.textContent).not.toContain("Synthetic private conversation check");
  await click("Retry loading"); expect(host.textContent).toContain("Synthetic private conversation check");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("aborts a pending read on navigation and clears its visible timers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  await mount(); await act(async () => root.unmount()); root = null;
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  // jsdom queues a zero-delay storage event for the payload-free timing receipt.
  await act(async () => vi.advanceTimersByTime(0));
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(timing()[0].outcome).toBe("cancelled");
});

it("restarts the initial cancelled read in StrictMode without stale state", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response())));
  await mount(true);
  expect(host.textContent).toContain("Synthetic private conversation check");
  expect(host.textContent).not.toContain("in progress");
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetch.mock.calls.at(-1)[1].signal.aborted).toBe(false);
});
