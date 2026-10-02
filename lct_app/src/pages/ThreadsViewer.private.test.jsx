// @vitest-environment jsdom
// Intent: tests/intent/sites-private-conversation.md. All content/history is synthetic.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRIVATE_CONVERSATION_FIXTURE } from "../services/cloud/privateConversationFixture";

const context = vi.hoisted(() => ({ local: null, navigate: vi.fn(), remote: vi.fn(), close: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => context.navigate, useParams: () => ({ artifactId: "colliding-local-id", publicId: "ignored-public" }), useLocation: () => ({ pathname: "/private-files", search: "?src=https%3A%2F%2Fignored.invalid%2Fmap&driveFile=ignored&public=1", state: { threadsBundle: { graph_data: [{ id: "wrong", node_name: "Wrong routed content" }] } } }), Link: "a" }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => ({ conversations: { fetchThreadsFile: context.remote } }) }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", useMediaQuery: () => false }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: async bundle => { context.local = bundle; return { id: "colliding-local-id" }; }, getThreadsLibraryRecord: () => { context.local = "unwanted local read"; return Promise.resolve(null); }, getThreadsLibraryRecordByDriveFileId: () => { context.local = "unwanted Drive read"; return Promise.resolve(null); } }));
vi.mock("../components/MinimalGraph", () => ({ default: ({ graphData, diagnosticsEnabled }) => <div data-testid="graph" data-diagnostics={String(diagnosticsEnabled)}>{graphData.map(node => node.node_name).join(" ")}</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: () => null }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: () => null }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => <div>Wrong Drive gate</div> }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => <div>Wrong public gate</div> }));
import ThreadsViewer from "./ThreadsViewer";

const fixture = { ...JSON.parse(PRIVATE_CONVERSATION_FIXTURE.text), conversation_id: "colliding-local-id" };
let root, host;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = true; localStorage.clear();
  window.history.replaceState({ marker: "existing-router-state" }, "", "/private-files#discussion=fixture-moment");
  context.local = { id: "colliding-local-id", title: "Existing local record" }; context.navigate.mockReset(); context.close.mockReset(); context.remote.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No alternate private network path is allowed"); }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.__MG_DEBUG__ = false; window.history.replaceState(null, "", "/"); });
const mount = (bundle = fixture) => act(async () => root.render(<ThreadsViewer privateBundle={bundle} onPrivateClose={context.close} />));
const click = label => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label).click());

it("opens only the supplied private graph despite competing public/local/Drive/src/router inputs, without persistence, URL changes or diagnostics", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), originalUrl = window.location.href;
  await mount();
  expect(host.textContent).toContain("Fixture idea");
  expect(host.textContent).toContain("Private cloud copy · edits stay in this view");
  expect(host.textContent).not.toMatch(/Wrong routed content|Wrong .*gate|drop a file|visible to everyone/i);
  expect(host.querySelector('[data-testid="graph"]').dataset.diagnostics).toBe("false");
  expect(context.local).toEqual({ id: "colliding-local-id", title: "Existing local record" });
  expect(context.remote).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0); expect(window.location.href).toBe(originalUrl); expect(window.history.state).toEqual({ marker: "existing-router-state" });
});

it("reads bundled exact discussion, hides share-link controls and keeps speaker naming in memory", async () => {
  const originalUrl = window.location.href;
  await mount(); await click("Discussion");
  expect(host.querySelector('[aria-label="Discussion"]')).toBeTruthy();
  expect(host.querySelector('[data-utterance-id="fixture-utterance-1"]').textContent).toContain("Synthetic question for the storage check.");
  expect(host.querySelector('button[aria-label^="Copy link"]')).toBeNull();
  expect(host.textContent).toContain("Names change in this view only");
  const input = host.querySelector('form input');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Reviewed fixture speaker"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector('form').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Reviewed fixture speaker");
  expect(context.local).toEqual({ id: "colliding-local-id", title: "Existing local record" });
  expect(fixture.utterances[0].speaker_display).toBeUndefined();
  expect(localStorage.length).toBe(0); expect(window.location.href).toBe(originalUrl); expect(fetch).not.toHaveBeenCalled();
});

it.each(["Library", "Open another file", "Close private conversation"])("returns %s to the private list without creating another route/history entry", async label => {
  const originalUrl = window.location.href;
  await mount(); await click(label);
  expect(context.close).toHaveBeenCalledTimes(1); expect(context.navigate).not.toHaveBeenCalled();
  expect(window.location.href).toBe(originalUrl); expect(context.local).toEqual({ id: "colliding-local-id", title: "Existing local record" });
});

it("keeps an invalid private map on a protected error/return path with no public or local fallback", async () => {
  await mount({ format: "invalid-sensitive-marker", graph_data: [] });
  expect(host.textContent).toContain("cannot be displayed");
  expect(host.textContent).not.toMatch(/invalid-sensitive-marker|Wrong .*gate|Choose file/);
  expect(fetch).not.toHaveBeenCalled(); expect(context.remote).not.toHaveBeenCalled();
  await click("Back to private files"); expect(context.close).toHaveBeenCalledTimes(1);
});
