// @vitest-environment jsdom
// Intent: tests/intent/sites-public-threads.md; synthetic file/key fixtures.
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PublicThreads from "./PublicThreads";

const status = { enabled: true, configured: true, visibility: "public" };
const fixture = { format: "lct.threads", format_version: 2, conversation_title: "Synthetic map", graph_data: [{ id: "one", node_name: "Fixture idea" }], edges: [], edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" } };
const json = (value, code = 200) => ({ ok: code < 400, status: code, json: async () => value });
const api = "/api/cloud/public-threads";
let root, host, rows;
function server(path, options) {
  if (path.endsWith("/status")) return Promise.resolve(json(status));
  if (options.method === "POST") {
    const item = { id: path.split("/").at(-1), title: fixture.conversation_title, node_count: 1, byte_size: 200, visibility: "public" };
    rows = [item]; return Promise.resolve(json({ item }, 201));
  }
  if (options.method === "DELETE") { rows = []; return Promise.resolve(json({ removed: true })); }
  return Promise.resolve(json({ items: rows, next: null }));
}
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; rows = []; localStorage.clear(); vi.stubGlobal("fetch", vi.fn(server)); });
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); root = null; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(strict = false) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const page = <MemoryRouter><PublicThreads /></MemoryRouter>;
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
}
const button = label => [...host.querySelectorAll("button")].find(node => node.textContent === label);
const click = label => act(async () => { expect(button(label)).toBeTruthy(); button(label).click(); });
async function choose() {
  const file = new File([JSON.stringify(fixture)], "synthetic.threads", { type: "application/json" });
  file.text = async () => JSON.stringify(fixture);
  const input = host.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
const permit = () => act(async () => host.querySelector('input[type="checkbox"]').click());

describe("Guest public library", () => {
  it("opens without sign-in and keeps inactive storage free of file selectors", async () => {
    fetch.mockResolvedValue(json({ ...status, enabled: false }));
    await mount();
    expect(host.textContent).toContain("without signing in");
    expect(host.textContent).toContain("not activated yet");
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].credentials).toBe("omit");
    expect(host.querySelector('a[href="/private-files"]')).toBeTruthy();
  });

  it("prepares locally, requires explicit whole-file consent, saves the key before publication and confirms removal", async () => {
    await mount(); await choose();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Review everything that will become public");
    expect(host.querySelector("pre").textContent).toContain("Fixture idea");
    expect(button("Publish public copy").disabled).toBe(true);
    await permit();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((path, options) => {
      if (options.method === "POST") {
        const keys = JSON.parse(localStorage.getItem("lct.public_removal_keys.v1"));
        expect(keys[0].id).toBe(path.split("/").at(-1));
        expect(keys[0].key).toBe(options.headers["X-LCT-Removal-Key"]);
        expect(options.headers["X-LCT-Public-Consent"]).toBe("whole-file-v1");
        expect(JSON.parse(options.body)).toEqual(fixture);
      }
      return original(path, options);
    });
    await click("Publish public copy");
    expect(host.textContent).toContain("Public copy saved");
    const item = rows[0];
    expect(host.querySelector(`a[href="/public/${item.id}"]`)).toBeTruthy();
    expect([...host.querySelectorAll("a")].some(link => link.href.includes("key="))).toBe(false);
    await click("Remove public copy");
    expect(fetch.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(0);
    await click("Confirm public removal");
    expect(rows).toEqual([]);
    expect(host.textContent).toContain("Public copy removed");
    const history = localStorage.getItem("lct.public_tasks_timing.v1");
    expect(history).not.toMatch(/Synthetic|Fixture|11111111|"id"|"key"/);
    expect(JSON.parse(history).every(item => Object.keys(item).sort().join() === "durationMs,outcome,retryCount,stage")).toBe(true);
  });

  it("cancels a stalled publication, shows elapsed time and retries the identical capability and payload", async () => {
    vi.useFakeTimers(); await mount(); await choose(); await permit();
    let first;
    fetch.mockImplementationOnce((path, options) => { first = { path, options }; return new Promise(() => {}); });
    await click("Publish public copy");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain("2s elapsed · Time remaining unknown");
    await click("Cancel");
    expect(first.options.signal.aborted).toBe(true);
    expect(host.textContent).toContain("outcome is uncertain");
    expect(host.querySelector("pre")).toBeTruthy();
    await click("Retry same publication");
    const posts = fetch.mock.calls.filter(([, options]) => options.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1][0]).toBe(first.path);
    expect(posts[1][1].headers).toEqual(first.options.headers);
    expect(posts[1][1].body).toBe(first.options.body);
    expect(host.textContent).toContain("Public copy saved");
  });

  it("times out list/status and retries without relying on response payloads", async () => {
    vi.useFakeTimers(); fetch.mockImplementationOnce(() => new Promise(() => {}));
    await mount();
    await act(async () => vi.advanceTimersByTime(30001));
    expect(host.textContent).toContain("took too long");
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await click("Refresh public library");
    expect(host.querySelector('input[type="file"]')).toBeTruthy();
  });

  it("restarts safely in StrictMode and aborts loading on navigation", async () => {
    await mount(true);
    expect(host.textContent).toContain("No public conversations yet");
    expect(host.textContent).not.toContain("in progress");
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    await click("Refresh public library");
    const signal = fetch.mock.calls.at(-1)[1].signal;
    await act(async () => root.unmount()); root = null;
    expect(signal.aborted).toBe(true);
  });

  it("fails closed before publication when removal-key storage is unavailable", async () => {
    await mount(); await choose(); await permit();
    const store = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic storage unavailable"); });
    await click("Publish public copy");
    expect(host.textContent).toContain("Enable browser storage before publishing");
    expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(0);
    store.mockRestore();
  });

  it("offers exact recoverable key details and exports a complete local file with a usable object URL", async () => {
    await mount(); await choose(); await permit(); await click("Publish public copy");
    const capability = JSON.parse(localStorage.getItem("lct.public_removal_keys.v1"))[0];
    const disclosure = [...host.querySelectorAll("summary")].find(node => node.textContent === "View removal details");
    await act(async () => disclosure.click());
    const idInput = host.querySelector('input[id^="saved-id-"]'), keyInput = host.querySelector('input[id^="saved-key-"]');
    expect(idInput.value).toBe(capability.id); expect(keyInput.value).toBe(capability.key);
    expect(keyInput.type).toBe("password");
    await click("Show removal key"); expect(keyInput.type).toBe("text");
    await click("Hide removal key"); expect(keyInput.type).toBe("password");
    vi.useFakeTimers();
    let blob, connected;
    vi.stubGlobal("URL", class extends URL { static createObjectURL(value) { blob = value; return "blob:synthetic-removal"; } static revokeObjectURL = vi.fn(); });
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { connected = this.isConnected; });
    await click("Download removal key");
    const fileText = new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob); });
    expect(connected).toBe(true); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    // FileReader delivery is also scheduled by the fake clock.
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-removal");
    expect(JSON.parse(await fileText)).toEqual({ site: window.location.origin, ...capability });
    anchor.mockRestore();
  });
});
