// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivateFiles from "./PrivateFiles";

const limits = { maxFileBytes: 2097152 };
const status = { enabled: true, configured: true, visibility: "private", limits };
const fileRow = { id: "00000000-0000-4000-8000-000000000001", filename: "notes.txt", title: "notes.txt", kind: "file", byte_size: 5, state: "ready", visibility: "private", created_at: 1 };
const json = (payload, code = 200) => ({ ok: code < 400, status: code, json: async () => payload });
let root;
let host;

async function mount(strict = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const page = <MemoryRouter><PrivateFiles /></MemoryRouter>;
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
}

async function click(label) {
  const target = [...host.querySelectorAll("button")].find((node) => node.textContent.includes(label));
  expect(target, `button ${label}`).toBeTruthy();
  await act(async () => target.click());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PrivateFiles", () => {
  it("restarts the cancelled initial check in StrictMode without stale activity or errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...status, enabled: false })));
    await mount(true);
    expect(host.textContent).toContain("Private storage is inactive");
    expect(host.textContent).not.toContain("in progress");
    expect(host.textContent).not.toContain("Checking storage");
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it("times out status with recovery and reports malformed responses without crashing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json({ ...status, enabled: false })));
    await mount();
    await act(async () => vi.advanceTimersByTime(30001));
    expect(host.textContent).toContain("Storage status took too long. Retry.");
    await click("Retry storage status");
    expect(host.textContent).toContain("unreadable response");
    await click("Retry storage status");
    expect(host.textContent).toContain("Private storage is inactive");
  });
  it("checks status first and keeps inactive storage free of upload controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...status, enabled: false })));
    await mount();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/cloud/files/status");
    expect(host.textContent).toContain("Private storage is inactive");
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector('a[href="/browse"]')).toBeTruthy();
  });

  it("requires account sign-in for a guest while leaving public navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(status)).mockResolvedValueOnce(json({ code: "sign_in", error: "Sign in" }, 401)));
    await mount();
    expect(host.textContent).toContain("Sign in to see your files");
    expect([...host.querySelectorAll("a")].find((link) => link.textContent === "Sign in with ChatGPT")?.target).toBe("_top");
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.querySelector('a[href="/"]')).toBeTruthy();
  });

  it("uploads raw bytes with private write headers, lists a ready download, then confirms deletion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(status))
      .mockResolvedValueOnce(json({ files: [], next: null }))
      .mockResolvedValueOnce(json({ file: fileRow }, 201))
      .mockResolvedValueOnce(json({ files: [fileRow], next: null }))
      .mockResolvedValueOnce(json({ deleted: true }))
      .mockResolvedValueOnce(json({ files: [], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    const chosen = new File(["hello"], "notes.txt", { type: "text/plain" });
    const input = host.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await click("Upload file");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/cloud/files");
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ method: "POST", body: chosen, credentials: "same-origin", headers: { "Content-Type": "text/plain", "X-LCT-Filename": "notes.txt", "X-LCT-Storage-Write": "1" } }));
    expect(host.querySelector(`a[href="/api/cloud/files/${fileRow.id}/content"]`)).toBeTruthy();
    await click("Delete");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(host.textContent).toContain("cannot be undone");
    await click("Delete permanently");
    expect(fetchMock.mock.calls[4][1]).toEqual(expect.objectContaining({ method: "DELETE", headers: { "X-LCT-Storage-Write": "1" } }));
    expect(host.textContent).toContain("No private cloud files here yet");
    const history = JSON.parse(localStorage.getItem("lct.private_files_timing.v1"));
    expect(history.every((entry) => Object.keys(entry).sort().join() === "durationMs,operation,outcome,retryCount")).toBe(true);
    expect(localStorage.getItem("lct.private_files_timing.v1")).not.toContain("notes.txt");
  });

  it("shows elapsed time, cancels a slow upload, preserves the file, and refreshes without duplicate POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(status))
      .mockResolvedValueOnce(json({ files: [], next: null }))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(json({ files: [], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    const chosen = new File(["hello"], "notes.txt", { type: "text/plain" });
    const input = host.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    let pending;
    await act(async () => { pending = [...host.querySelectorAll("button")].find((node) => node.textContent === "Upload file").click(); });
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain("2s elapsed · Time remaining unknown");
    await click("Cancel");
    await act(async () => pending);
    expect(host.textContent).toContain("Upload outcome is uncertain");
    expect(input.files[0]).toBe(chosen);
    expect(fetchMock.mock.calls.filter(([path, options]) => path === "/api/cloud/files" && options.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls[3][0]).toBe("/api/cloud/files");
  });

  it("offers only the known fixture in synthetic mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...status, synthetic_only: true }))
      .mockResolvedValueOnce(json({ files: [], next: null }))
      .mockResolvedValueOnce(json({ file: fileRow }, 201))
      .mockResolvedValueOnce(json({ files: [fileRow], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    await click("Run private storage check");
    const request = fetchMock.mock.calls[2][1];
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ "Content-Type": "text/plain", "X-LCT-Filename": "lct-storage-check.txt", "X-LCT-Storage-Write": "1" });
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(request.body);
    });
    expect(content).toBe("LCT synthetic private storage fixture.\nNo personal data.\n");
  });

  it("aborts a pending request on navigation without starting another operation", async () => {
    vi.useFakeTimers();
    let signal;
    vi.stubGlobal("fetch", vi.fn((_path, options) => { signal = options.signal; return new Promise(() => {}); }));
    await mount();
    expect(signal.aborted).toBe(false);
    await act(async () => root.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
