import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { straightTree, utterances } from "../components/discussion/discussionFixtures";

const context = vi.hoisted(() => ({ compact: false, bundle: null }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ pathname: "/view", search: "", state: { threadsBundle: context.bundle } }) }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", mediaQueryMatches: () => context.compact, useMediaQuery: () => context.compact }));
vi.mock("../services/threadsArtifact", () => ({ validateThreadsArtifact: (value) => value, flattenThreadsGraph: (value) => value.flat(), readThreadsFile: vi.fn() }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: async () => ({ id: "fixture" }), getThreadsLibraryRecord: vi.fn(), getThreadsLibraryRecordByDriveFileId: vi.fn() }));
vi.mock("../components/MinimalGraph", () => ({ default: ({ onFocusChange, onVisibleLevelChange }) => <div data-testid="graph">Graph fixture
  <button type="button" onClick={() => onFocusChange({ node_name: "Focused idea", summary: "Focused summary" })}>Focus idea</button>
  <button type="button" onClick={() => onVisibleLevelChange({ mode: "semantic", level: 3 })}>Show topics</button>
</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: ({ semanticLevel, selectedNode, setSelectedNode }) => <div
  data-testid="timeline" data-level={semanticLevel || "all"} data-selected={selectedNode || ""}>
  <button type="button" onClick={() => setSelectedNode((previous) => previous ? null : "topic")}>Pick topic</button>
</div> }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: ({ compact }) => <aside data-testid="source" data-compact={String(compact)}>Source fixture</aside> }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/MobileConversationDeck", () => ({ default: () => <div>Cards fixture</div> }));
import ThreadsViewer from "./ThreadsViewer";
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = false; window.location.hash = "";
  context.bundle = { version: 1, conversation_title: "Synthetic conversation", graph_data: [straightTree], utterances, edges: [] };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); window.location.hash = ""; });
for (const compact of [false, true]) it(`opens Graph first and reads bundled discussion without backend calls (compact=${compact})`, async () => {
  context.compact = compact;
  const network = vi.fn(() => { throw new Error("Artifact Discussion must remain local"); }); vi.stubGlobal("fetch", network);
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
  const click = async (label) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent.includes(label)).click());
  await click("Discussion"); await click("Topic A"); await click("Idea A"); await click("Moment A");
  expect(host.querySelector('[data-utterance-id="u1"]').textContent).toContain(utterances[0].text);
  expect(network).not.toHaveBeenCalled();
  await click("Graph"); expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
  if (compact) { await click("Cards"); expect(host.textContent).toContain("Cards fixture"); }
});

it("opens a shared Discussion link at its exact branch on a fresh artifact load", async () => {
  context.compact = false;
  window.location.hash = "#discussion=moment";
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="graph"]')).toBeNull();
  expect(host.querySelector('[data-discussion-node="moment"]')).not.toBeNull();
  expect(host.querySelector('[data-utterance-id="u1"]')).not.toBeNull();
});

it("follows a Discussion link added while the artifact is already open", async () => {
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
  await act(async () => {
    window.history.replaceState(null, "", "#discussion=moment");
    window.dispatchEvent(new Event("hashchange"));
  });
  expect(host.querySelector('[data-discussion-node="moment"]')).not.toBeNull();
  expect(host.querySelector('[data-utterance-id="u1"]')).not.toBeNull();
});

it("reveals Overview from the compact graph and returns Cards to Graph after widening", async () => {
  context.compact = true;
  context.bundle.executive_summary = "Synthetic overview";
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.textContent).not.toContain("Synthetic overview");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Overview").click());
  expect(host.textContent).toContain("Synthetic overview");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Cards").click());
  expect(host.textContent).toContain("Cards fixture");
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
  expect([...host.querySelectorAll('[aria-label="Conversation view"] button')]
    .find((button) => button.textContent === "Graph").getAttribute("aria-pressed")).toBe("true");
});

it("keeps a focused node overview available when switching to Discussion", async () => {
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Focus idea").click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Discussion").click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Overview").click());
  expect(host.textContent).toContain("Focused summary");
});

it("exits graph focus when a Discussion link is opened", async () => {
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("summary")].find((item) => item.textContent === "More").click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Focus graph").click());
  expect(host.querySelector('[aria-label="Conversation view"]')).toBeNull();
  await act(async () => {
    window.history.replaceState(null, "", "#discussion=moment");
    window.dispatchEvent(new Event("hashchange"));
  });
  expect(host.querySelector('[aria-label="Discussion"]')).not.toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Graph").click());
  expect(host.querySelector('[aria-label="Conversation view"]')).not.toBeNull();
});

it("keeps Source stacked on a narrow screen and closes it for graph Focus", async () => {
  context.compact = true;
  context.bundle.media_refs = [{ provider: "youtube", video_id: "ABCDEFGHIJK", view_url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", time_unit: "seconds" }];
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Source").click());
  expect(host.querySelector('[data-testid="source"]').getAttribute("data-compact")).toBe("true");
  expect(host.querySelector('[data-testid="source"]').parentElement.className).toContain("flex-col");
  await act(async () => [...host.querySelectorAll("summary")].find((item) => item.textContent === "More").click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Focus graph").click());
  expect(host.querySelector('[data-testid="source"]')).toBeNull();
  expect(host.querySelector('h1')).toBeNull();
});

it("uses the same fallback timeline level in Graph and Discussion", async () => {
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Show topics").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-level")).toBe("3");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Discussion").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-level")).toBe("3");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick topic").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-selected")).toBe("topic");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick topic").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-selected")).toBe("topic");
});
