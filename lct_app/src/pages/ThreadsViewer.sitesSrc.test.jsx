// @vitest-environment jsdom
// Intent: a hosted `.threads` shared as /view?src=<url> opens on the Site, whose
// serverless data provider is the one in use there. Found by the 2026-11-05 UX
// review: the live Site showed "s.conversations.fetchThreadsFile is not a function".
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerlessDataProvider } from "../services/ServerlessDataProvider";

const src = "https://maps.example.test/shared.threads";
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ pathname: "/view", search: `?src=${encodeURIComponent(src)}`, state: null }) }));
// One instance, as App holds one: a new provider per render would re-run the viewer's effects.
const provider = vi.hoisted(() => ({ current: null }));
vi.mock("../services/dataProvider", async importOriginal => ({ ...(await importOriginal()), useDataProvider: () => provider.current }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", useMediaQuery: () => false }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: async () => ({ id: "local" }), getThreadsLibraryRecord: vi.fn(), getThreadsLibraryRecordByDriveFileId: vi.fn() }));
vi.mock("../components/MinimalGraph", () => ({ default: ({ graphData }) => <div data-testid="graph">{graphData.map(node => node.node_name).join(" ")}</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: () => null }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: () => null }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/discussion/DiscussionView", () => ({ default: () => null }));
import ThreadsViewer from "./ThreadsViewer";

const fixture = { format: "lct.threads", format_version: 2, conversation_id: "shared-src", conversation_title: "Shared by link", graph_data: [{ id: "one", node_name: "Synthetic shared idea", summary: "No personal data", semantic_level: 1 }], edges: [], edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" } };
let root, host;
// The viewer reads `?src=` from window.location, not the router.
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = false; localStorage.clear(); window.history.replaceState(null, "", `/view?src=${encodeURIComponent(src)}`); provider.current = new ServerlessDataProvider(""); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("opens a ?src= link with the Site's serverless provider, without sending Site credentials", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => structuredClone(fixture) }));
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).not.toContain("Could not load artifact");
  expect(host.textContent).toContain("Synthetic shared idea");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(src);
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
});

it("reports a network-level ?src= failure (CORS, DNS) as a load error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain("Could not load artifact: Failed to fetch");
});

it("reports a failed ?src= fetch as a load error rather than a crash", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).toContain("Could not load artifact: fetch failed (404)");
  expect(host.textContent).not.toContain("is not a function");
});
