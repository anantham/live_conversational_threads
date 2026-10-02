// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sitesWorker from "../../sites/worker.js";
import SitesAccessPanel from "./SitesAccessPanel";

let root;
let container;
let navigate;

function NavigationCapture() {
  navigate = useNavigate();
  return null;
}

async function mount(initialPath = "/") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter initialEntries={[initialPath]}><NavigationCapture /><SitesAccessPanel /></MemoryRouter>); });
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
  navigate = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SitesAccessPanel", () => {
  // Test intent: Google remains unavailable until runtime configuration; failures and cancellation
  // leave public browsing usable; sign-out revokes the app session before platform navigation.
  it("keeps Google sign-in inactive until the runtime config is enabled and configured", async () => {
    localStorage.setItem("lct.sites_auth_ui_timing.v1", JSON.stringify([
      { stage: "config", durationMs: 1, outcome: "complete", retryCount: 0, credential: "must-drop" },
      { stage: "config", durationMs: 1, outcome: "complete", retryCount: -1 },
    ]));
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/auth/session" ? { status: 401 } :
      { ok: true, json: async () => ({ google: { enabled: true, configured: false } }) }));
    await mount();
    expect(container.textContent).toContain("Browsing as guest");
    expect(container.querySelector('a[href="/privacy"]')?.textContent).toBe("Privacy and data use");
    expect(container.textContent).not.toContain("Sign in with Google");
    expect(fetch).toHaveBeenCalledWith("/api/auth/config", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    const history = JSON.parse(localStorage.getItem("lct.sites_auth_ui_timing.v1"));
    expect(history).toHaveLength(2);
    expect(history.every((sample) => Object.keys(sample).sort().join(",") === "durationMs,outcome,retryCount,stage")).toBe(true);
    expect(JSON.stringify(history)).not.toContain("must-drop");
  });

  it("reports a Google script error, offers retry, and cancels an unfinished challenge", async () => {
    let challengeSignal;
    fetch.mockImplementation((path, options) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      challengeSignal = options.signal;
      return Promise.resolve({ ok: true, json: async () => ({ nonce: "synthetic-nonce" }) });
    });
    const append = vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      queueMicrotask(() => node.onerror?.());
      return node;
    });
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in with Google").click());
    expect(container.textContent).toContain("Google sign-in could not load");
    expect(container.textContent).toContain("Sign in with Google");
    expect(challengeSignal.aborted).toBe(false);
    append.mockRestore();
  });

  it("aborts a pending Google challenge when the user cancels", async () => {
    let challengeSignal;
    fetch.mockImplementation((path, options) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      challengeSignal = options.signal;
      return new Promise(() => {});
    });
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in with Google").click());
    expect(container.textContent).toContain("Starting Google sign-in");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel Google sign-in").click());
    expect(challengeSignal.aborted).toBe(true);
    expect(container.textContent).toContain("Sign in with Google");
  });

  it("ignores a cancelled challenge that resolves late without loading the Google script", async () => {
    let resolveChallenge;
    const append = vi.spyOn(document.head, "appendChild");
    fetch.mockImplementation((path) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      return new Promise((resolve) => { resolveChallenge = resolve; });
    });
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in with Google").click());
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel Google sign-in").click());
    await act(async () => resolveChallenge({ ok: true, json: async () => ({ nonce: "late" }) }));
    expect(append).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sign in with Google");
    append.mockRestore();
  });

  it("times out a stalled Google config check and recovers on retry", async () => {
    vi.useFakeTimers();
    let configCalls = 0;
    fetch.mockImplementation((path) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") {
        configCalls += 1;
        return configCalls === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      }
      throw new Error("Unexpected request");
    });
    await mount();
    expect(container.textContent).toContain("Checking Google sign-in availability");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(container.textContent).toContain("Google sign-in availability could not be checked");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry Google availability").click());
    expect(container.textContent).toContain("Sign in with Google");
    expect(JSON.parse(localStorage.getItem("lct.sites_auth_ui_timing.v1")).some((sample) => sample.stage === "config" && sample.outcome === "timeout")).toBe(true);
  });

  it("submits a Google credential with the protected write header and offers retry after refusal", async () => {
    let gisOptions;
    vi.stubGlobal("google", { accounts: { id: {
      initialize: (options) => { gisOptions = options; },
      renderButton: (element) => { element.textContent = "Google account chooser"; },
      cancel: vi.fn(),
    } } });
    fetch.mockImplementation((path) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      if (path === "/api/auth/google/challenge") return Promise.resolve({ ok: true, json: async () => ({ nonce: "synthetic-nonce" }) });
      return Promise.resolve({ ok: false, json: async () => ({ error: "Identity response was refused." }) });
    });
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in with Google").click());
    expect(gisOptions).toEqual(expect.objectContaining({ client_id: "test.apps.googleusercontent.com", nonce: "synthetic-nonce", callback: expect.any(Function) }));
    expect(container.textContent).toContain("Waiting for Google");
    await act(async () => gisOptions.callback({ credential: "synthetic-credential" }));
    expect(fetch).toHaveBeenCalledWith("/api/auth/google", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: expect.objectContaining({ "x-lct-auth-write": "1", "Content-Type": "application/json" }),
      body: JSON.stringify({ credential: "synthetic-credential" }),
    }));
    expect(container.textContent).toContain("Identity response was refused.");
    expect(container.textContent).toContain("Sign in with Google");
    expect(localStorage.getItem("lct.sites_session_check_timing.v1")).not.toContain("synthetic-credential");
  });

  it("blocks a late Google callback while a guest resets sign-in", async () => {
    let gisOptions;
    vi.stubGlobal("google", { accounts: { id: {
      initialize: (options) => { gisOptions = options; }, renderButton: vi.fn(), cancel: vi.fn(),
    } } });
    fetch.mockImplementation((path) => {
      if (path === "/api/auth/session") return Promise.resolve({ status: 401 });
      if (path === "/api/auth/config") return Promise.resolve({ ok: true, json: async () => ({ google: { enabled: true, configured: true, client_id: "test.apps.googleusercontent.com" } }) });
      if (path === "/api/auth/google/challenge") return Promise.resolve({ ok: true, json: async () => ({ nonce: "synthetic-nonce" }) });
      if (path === "/api/auth/logout") return new Promise(() => {});
      throw new Error("Unexpected verification request");
    });
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in with Google").click());
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset sign-in").click());
    expect(container.textContent).toContain("Signing out");
    await act(async () => gisOptions.callback({ credential: "late-credential" }));
    expect(fetch.mock.calls.some(([path]) => path === "/api/auth/google")).toBe(false);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel sign-out").click());
  });

  it("revokes the app session before opening platform sign-out and keeps retry on failure", async () => {
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/auth/session" ?
      { status: 200, json: async () => ({ authenticated: true, user: { id: "synthetic" } }) } : { ok: false }));
    await mount("/private-files?tab=mine");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign out").click());
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", credentials: "same-origin", headers: expect.objectContaining({ "x-lct-auth-write": "1" }) }));
    expect(container.textContent).toContain("Sign-out could not finish");
    expect(container.textContent).toContain("Sign out");
  });

  it("uses the current path for platform sign-out only after app logout succeeds", async () => {
    const navigation = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      navigation.push({ href: this.getAttribute("href"), target: this.target, calls: fetch.mock.calls.length });
    });
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/auth/session" ?
      { status: 200, json: async () => ({ authenticated: true, user: { id: "synthetic" } }) } : { ok: true, json: async () => ({ authenticated: false }) }));
    await mount("/private-files?tab=mine");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign out").click());
    expect(navigation).toEqual([{ href: "/signout-with-chatgpt?return_to=%2Fprivate-files%3Ftab%3Dmine", target: "_top", calls: 2 }]);
    click.mockRestore();
  });

  it("lets a guest clear a rejected prior session before choosing another provider", async () => {
    const navigation = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { navigation.push(this.getAttribute("href")); });
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/auth/session" ? { status: 401 } :
      path === "/api/auth/config" ? { ok: true, json: async () => ({ google: { enabled: false, configured: false } }) } :
        { ok: true, json: async () => ({ authenticated: false }) }));
    await mount("/private-files");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset sign-in").click());
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-lct-auth-write": "1" }) }));
    expect(navigation).toEqual(["/signout-with-chatgpt?return_to=%2Fprivate-files"]);
    click.mockRestore();
  });

  it("times out a stalled sign-out and leaves a retry control", async () => {
    vi.useFakeTimers();
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/auth/session" ?
      { status: 200, json: async () => ({ authenticated: true, user: { id: "synthetic" } }) } :
      { ok: true, json: async () => new Promise(() => {}) }));
    await mount();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign out").click());
    await act(async () => vi.advanceTimersByTime(3000));
    expect(container.textContent).toContain("3s elapsed");
    await act(async () => vi.advanceTimersByTime(7000));
    expect(container.textContent).toContain("Sign-out could not finish");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Sign out" && !button.disabled)).toBe(true);
    expect(JSON.parse(localStorage.getItem("lct.sites_auth_ui_timing.v1")).some((sample) => sample.stage === "signout" && sample.outcome === "timeout")).toBe(true);
  });
  it("uses document flow on private files and floats elsewhere without repeating the session check", async () => {
    fetch.mockResolvedValue({ status: 200, json: async () => ({ authenticated: true, user: { id: "private-id" } }) });
    await mount("/private-files");
    const panel = container.querySelector('aside[aria-label="Site access"]');
    expect(panel.id).toBe("site-access");
    expect(panel.tabIndex).toBe(-1);
    expect(panel.classList.contains("fixed")).toBe(false);
    expect(panel.classList.contains("overflow-y-auto")).toBe(false);
    expect(panel.classList.contains("max-h-[45dvh]")).toBe(false);
    expect(panel.textContent).toContain("Signed in");
    expect([...panel.querySelectorAll("button")].some((button) => button.textContent === "Sign out")).toBe(true);

    await act(async () => navigate("/private-files/"));
    expect(container.querySelector("aside")).toBe(panel);
    expect(panel.classList.contains("fixed")).toBe(false);

    await act(async () => navigate("/"));
    expect(container.querySelector("aside")).toBe(panel);
    expect(panel.classList.contains("fixed")).toBe(true);
    expect(panel.classList.contains("overflow-y-auto")).toBe(true);
    expect(panel.textContent).toContain("Signed in");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
    const signOut = [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign out");
    expect(signOut).toBeTruthy();
  });

  it("offers retry after a malformed successful response and recovers to guest", async () => {
    fetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ authenticated: true, user: { id: "" } }) })
      .mockResolvedValueOnce({ status: 401 });
    await mount();
    expect(container.textContent).toContain("Sign-in check failed");
    expect(container.querySelector('a[href="/privacy"]')?.textContent).toBe("Privacy and data use");
    await act(async () => container.querySelector("button").click());
    expect(container.textContent).toContain("Browsing as guest");
    expect(fetch).toHaveBeenCalledTimes(3);
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
