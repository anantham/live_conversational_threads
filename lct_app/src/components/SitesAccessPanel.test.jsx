// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sitesWorker from "../../sites/worker.js";
import SitesAccessPanel from "./SitesAccessPanel";

let root;
let container;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<SitesAccessPanel />); });
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", vi.fn());
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SitesAccessPanel", () => {
  it("shows a guest on 401, keeps public browsing, and uses same-origin no-store session checks", async () => {
    fetch.mockResolvedValue({ status: 401 });
    await mount();
    expect(container.textContent).toContain("Browsing as guest");
    expect(container.textContent).toContain("Opening browser-local files does not publish them.");
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    const signIn = [...container.querySelectorAll("a")].find((link) => link.textContent === "Sign in with ChatGPT");
    expect(signIn?.getAttribute("href")).toBe("/signin-with-chatgpt?return_to=%2F");
    expect(signIn?.target).toBe("_top");
  });

  it("shows signed-in only for a valid authenticated response and never renders identity", async () => {
    fetch.mockImplementation((path, options) => sitesWorker.fetch(new Request(new URL(path, "https://site.example"), {
      method: "GET",
      headers: { "oai-authenticated-user-id": "private-id" },
      signal: options.signal,
    })));
    await mount();
    expect(container.textContent).toContain("Signed in");
    expect(container.textContent).not.toContain("private-id");
    const history = JSON.parse(localStorage.getItem("lct.sites_session_check_timing.v1"));
    expect(history).toEqual([{ durationMs: expect.any(Number), outcome: "signed-in", retryCount: 0 }]);
    expect(localStorage.getItem("lct.sites_session_check_timing.v1")).not.toContain("private-id");
    const signOut = [...container.querySelectorAll("a")].find((link) => link.textContent === "Sign out");
    expect(signOut?.getAttribute("href")).toBe("/signout-with-chatgpt?return_to=%2F");
  });

  it("offers retry after a malformed successful response and recovers to guest", async () => {
    fetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ authenticated: true, user: { id: "" } }) })
      .mockResolvedValueOnce({ status: 401 });
    await mount();
    expect(container.textContent).toContain("Sign-in check failed");
    await act(async () => container.querySelector("button").click());
    expect(container.textContent).toContain("Browsing as guest");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("lct.sites_session_check_timing.v1"))).toEqual([
      { durationMs: expect.any(Number), outcome: "error", retryCount: 0 },
      { durationMs: expect.any(Number), outcome: "guest", retryCount: 1 },
    ]);
  });

  it("rejects a top-level id without a user object", async () => {
    fetch.mockResolvedValue({ status: 200, ok: true, json: async () => ({ authenticated: true, id: "private-id" }) });
    await mount();
    expect(container.textContent).toContain("Sign-in check failed");
    expect(container.textContent).not.toContain("Signed in");
  });

  it("does not treat a non-200 response as signed in", async () => {
    fetch.mockResolvedValue({ status: 201, ok: true, json: async () => ({ authenticated: true, user: { id: "private-id" } }) });
    await mount();
    expect(container.textContent).toContain("Sign-in check failed");
    expect(container.textContent).not.toContain("Signed in");
  });

  it("shows elapsed time during a slow check and recovers after timeout", async () => {
    vi.useFakeTimers();
    fetch.mockImplementation(() => new Promise(() => {}));
    await mount();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(container.textContent).toContain("3s elapsed");
    expect(container.textContent).toContain("Time remaining unknown");
    await act(async () => vi.advanceTimersByTime(7000));
    expect(container.textContent).toContain("Sign-in check failed");
    expect(container.textContent).toContain("keep browsing public content");
    expect(JSON.parse(localStorage.getItem("lct.sites_session_check_timing.v1"))[0].outcome).toBe("timeout");
    await settle();
  });

  it("aborts and clears timers when the panel unmounts", async () => {
    vi.useFakeTimers();
    const clearInterval = vi.spyOn(window, "clearInterval");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    fetch.mockImplementation(() => new Promise(() => {}));
    await mount();
    const signal = fetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    await act(async () => root.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    expect(clearInterval).toHaveBeenCalled();
    expect(clearTimeout).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("lct.sites_session_check_timing.v1"))[0].outcome).toBe("cancelled");
    vi.restoreAllMocks();
  });

  it("keeps at most eight payload-free timing samples", async () => {
    fetch.mockResolvedValue({ status: 500 });
    await mount();
    for (let index = 0; index < 9; index += 1) {
      await act(async () => container.querySelector("button").click());
    }
    const history = JSON.parse(localStorage.getItem("lct.sites_session_check_timing.v1"));
    expect(history).toHaveLength(8);
    expect(history.at(-1)).toEqual({ durationMs: expect.any(Number), outcome: "error", retryCount: 9 });
    expect(Object.keys(history.at(-1)).sort()).toEqual(["durationMs", "outcome", "retryCount"]);
  });
});
