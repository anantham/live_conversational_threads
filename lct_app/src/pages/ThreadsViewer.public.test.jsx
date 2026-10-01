// @vitest-environment jsdom
// Intent: tests/intent/sites-public-threads.md; public viewing never replaces local history.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ id: "00000000-0000-4000-8000-000000000001", local: { id: "same-local-id", title: "Private device fixture" }, navigate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => context.navigate, useParams: () => ({ publicId: context.id }), useLocation: () => ({ pathname: `/public/${context.id}`, search: "?src=https%3A%2F%2Ffixture-ignored.invalid%2Fmap&driveFile=ignored", state: null }), Link: ({ to, children }) => <a href={to}>{children}</a> }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", useMediaQuery: () => false }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: async bundle => { context.local = bundle; return { id: "same-local-id" }; }, getThreadsLibraryRecord: vi.fn(), getThreadsLibraryRecordByDriveFileId: vi.fn() }));
vi.mock("../components/MinimalGraph", () => ({ default: ({ graphData }) => <div data-testid="graph">{graphData.map(node => node.node_name).join(" ")}</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: () => null }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: () => null }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => <div>Wrong Drive gate</div> }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/discussion/DiscussionView", () => ({ default: ({ nodes, onRenameSpeaker, linkBase }) => <div><span>{nodes[0].speaker_display || "Original speaker"}</span><a data-testid="discussion-link" href={linkBase + "#discussion=one"}>Branch link</a><button type="button" onClick={() => onRenameSpeaker("speaker-one", "Reviewed name")}>Rename fixture speaker</button></div> }));
import ThreadsViewer from "./ThreadsViewer";

const fixture = { format: "lct.threads", format_version: 2, conversation_id: "same-local-id", conversation_title: "Public fixture", graph_data: [{ id: "one", node_name: "Synthetic public idea", summary: "No personal data", speaker_id: "speaker-one", speaker_display: "Original speaker", semantic_level: 1 }], edges: [], edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" } };
let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = false; localStorage.clear(); context.local = { id: "same-local-id", title: "Private device fixture" }; context.navigate.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const click = label => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label).click());

it("loads only the public endpoint, keeps branch links public and changes names in this view without replacing local history", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => structuredClone(fixture) }));
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain("Synthetic public idea");
  expect(host.textContent).toContain("visible to everyone");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(`/api/cloud/public-threads/${context.id}/content`);
  expect(fetch.mock.calls[0][1].credentials).toBe("omit");
  await click("Discussion");
  expect(host.querySelector('[data-testid="discussion-link"]').href).toContain(`/public/${context.id}`);
  await click("Rename fixture speaker");
  expect(host.textContent).toContain("Reviewed name");
  expect(context.local).toEqual({ id: "same-local-id", title: "Private device fixture" });
});

it("shows a stalled public load with elapsed time, cancellation and same-link retry", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ ok: true, json: async () => fixture }));
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.textContent).toContain("2s elapsed · Time remaining unknown");
  await click("Cancel");
  expect(host.textContent).toContain("Loading cancelled");
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await click("Retry loading");
  expect(host.textContent).toContain("Synthetic public idea");
  expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
});

it("aborts the public load on navigation without writing device history", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => root.unmount()); root = null;
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(context.local).toEqual({ id: "same-local-id", title: "Private device fixture" });
});
