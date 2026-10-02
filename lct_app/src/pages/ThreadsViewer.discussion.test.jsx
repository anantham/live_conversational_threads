import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { straightTree, utterances } from "../components/discussion/discussionFixtures";

const context = vi.hoisted(() => ({ compact: false, bundle: null, holdSave: false }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ pathname: "/view", search: "", state: { threadsBundle: context.bundle } }) }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", mediaQueryMatches: () => context.compact, useMediaQuery: () => context.compact }));
vi.mock("../services/threadsArtifact", () => ({ validateThreadsArtifact: (value) => value, flattenThreadsGraph: (value) => value.flat(), readThreadsFile: vi.fn() }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: () => context.holdSave ? new Promise(()=>{}) : Promise.resolve({id:"fixture"}), getThreadsLibraryRecord: vi.fn(), getThreadsLibraryRecordByDriveFileId: vi.fn() }));
vi.mock("../components/MinimalGraph", () => ({ default: ({ onFocusChange, onVisibleLevelChange, setSelectedNode, navigationNodeIds, speakerDisplayNames }) => <div data-testid="graph" data-navigation={navigationNodeIds.join(",")}>Graph fixture
  <span data-testid="graph-speaker-name">{speakerDisplayNames?.get("speaker-a")}</span>
  <button type="button" onClick={() => onFocusChange({ node_name: "Focused idea", summary: "Focused summary" })}>Focus idea</button>
  <button type="button" onClick={() => onVisibleLevelChange({ mode: "semantic", level: 3 })}>Show topics</button>
  <button type="button" onClick={() => setSelectedNode("moment")}>Open moment</button>
  <button type="button" onClick={() => setSelectedNode("outside")}>Open outside moment</button>
</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: ({ onSeekMedia }) => <button type="button" onClick={() => onSeekMedia?.(2273.56)}>Seek cited moment</button> }));
vi.mock("../components/TimelineRibbon", () => ({ default: ({ semanticLevel, selectedNode, setSelectedNode, onReadingPathChange }) => <div
  data-testid="timeline" data-level={semanticLevel || "all"} data-selected={selectedNode || ""}>
  <button type="button" onClick={() => setSelectedNode((previous) => previous ? null : "topic")}>Pick topic</button>
  <button type="button" onClick={() => onReadingPathChange({ threadId: "thread", nodeIds: ["moment"] })}>Select reading path</button>
</div> }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: ({ compact, seekRequest }) => <aside data-testid="source" data-compact={String(compact)} data-seek={seekRequest?.seconds ?? ""}>Source fixture</aside> }));
vi.mock("../components/threads/TextSourcePanel", () => ({ default: ({ selection, bundle, onRenameSpeaker }) => <aside data-testid="text-source" data-kind={selection?.kind || "default"} data-start={selection?.start ?? ""} data-utterance={selection?.utteranceId || ""}>Text source fixture
  <span>{bundle.utterances[0]?.speaker_name}</span><button onClick={()=>onRenameSpeaker("speaker-a","Reviewed alias")}>Apply fixture name</button>
</aside> }));
vi.mock("../components/threads/ViewerFindMenu", () => ({ default: ({ onResult }) => <div>
  <button type="button" onClick={() => onResult({ kind: "utterance", utteranceId: "u1", seconds: 12 })}>Find timed passage</button>
  <button type="button" onClick={() => onResult({ kind: "utterance", utteranceId: "u1" })}>Find untimed passage</button>
  <button type="button" onClick={() => onResult({ kind: "transcript", start: 5, end: 12 })}>Find transcript passage</button>
</div> }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/MobileConversationDeck", () => ({ default: () => <div>Cards fixture</div> }));
import ThreadsViewer from "./ThreadsViewer";
// Test intent: one view button cycles through the available views, while an
// evidence timestamp opens Source at its exact elapsed recording offset.
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = false; window.location.hash = "";
  context.holdSave = false;
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
  const viewButton = () => host.querySelector('[aria-label="Conversation view"] button');
  expect(viewButton().textContent).toContain("Discussion");
  await act(async () => viewButton().click());
  if (compact) {
    expect(viewButton().textContent).toContain("Cards");
    expect(host.textContent).toContain("Cards fixture");
    await act(async () => viewButton().click());
  }
  expect(viewButton().textContent).toContain("Graph");
  expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
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
  await act(async () => host.querySelector('button[aria-label^="Conversation overview:"]').click());
  expect(host.textContent).toContain("Synthetic overview");
  await act(async () => host.querySelector('[aria-label="Conversation view"] button').click());
  await act(async () => host.querySelector('[aria-label="Conversation view"] button').click());
  expect(host.textContent).toContain("Cards fixture");
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="graph"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Conversation view"] button').textContent).toContain("Graph");
});

it("keeps a focused node overview available when switching to Discussion", async () => {
  context.compact = false;
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Focus idea").click());
  await act(async () => host.querySelector('[aria-label="Conversation view"] button').click());
  await act(async () => host.querySelector('button[aria-label^="Conversation overview:"]').click());
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
  await act(async () => host.querySelector('[aria-label="Conversation view"] button').click());
  expect(host.querySelector('[aria-label="Conversation view"]')).not.toBeNull();
});

it("opens Source at the cited timestamp from closed node evidence", async () => {
  context.compact = false;
  context.bundle.media_refs = [{ provider: "youtube", video_id: "ABCDEFGHIJK", view_url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", time_unit: "seconds" }];
  await act(async () => root.render(<ThreadsViewer />));
  expect(host.querySelector('[data-testid="source"]')).toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Open moment").click());
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Seek cited moment").click());
  expect(host.querySelector('[data-testid="source"]')?.getAttribute("data-seek")).toBe("2273.56");
});

it("uses local text Source for untimed and transcript hits, and video for timed hits", async () => {
  context.compact = false;
  context.bundle.full_transcript = "Whole original transcript";
  context.bundle.media_refs = [{ provider: "youtube", video_id: "ABCDEFGHIJK", view_url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", time_unit: "seconds" }];
  await act(async () => root.render(<ThreadsViewer />));
  const choose = async (label) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === label).click());
  await choose("Find untimed passage");
  expect(host.querySelector('[data-testid="text-source"]')?.getAttribute("data-utterance")).toBe("u1");
  await choose("Find transcript passage");
  expect(host.querySelector('[data-testid="text-source"]')?.getAttribute("data-start")).toBe("5");
  await choose("Find timed passage");
  expect(host.querySelector('[data-testid="text-source"]')).toBeNull();
  expect(host.querySelector('[data-testid="source"]')?.getAttribute("data-seek")).toBe("12");
});

it("opens Source for text-only artifacts and clears a previous search selection on toggle", async () => {
  context.compact = false;
  context.bundle.full_transcript = "Whole original transcript";
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Find transcript passage").click());
  expect(host.querySelector('[data-testid="text-source"]')?.getAttribute("data-kind")).toBe("transcript");
  await act(async () => host.querySelector('button[aria-label="Source"]').click());
  expect(host.querySelector('[data-testid="text-source"]')).toBeNull();
  await act(async () => host.querySelector('button[aria-label="Source"]').click());
  expect(host.querySelector('[data-testid="text-source"]')?.getAttribute("data-kind")).toBe("default");
});

it("switches Graph navigation to all moments after a jump outside the selected thread", async () => {
  context.compact = false;
  context.bundle.graph_data = [[...straightTree, { id: "outside", semantic_level: 1, node_name: "Outside moment", timestamp_start: 20 }]];
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Select reading path").click());
  expect(host.querySelector('[data-testid="graph"]').getAttribute("data-navigation")).toBe("moment");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Open outside moment").click());
  expect(host.querySelector('[data-testid="graph"]').getAttribute("data-navigation")).toBe("moment,outside");
});

it("keeps Source stacked on a narrow screen and closes it for graph Focus", async () => {
  context.compact = true;
  context.bundle.media_refs = [{ provider: "youtube", video_id: "ABCDEFGHIJK", view_url: "https://www.youtube.com/watch?v=ABCDEFGHIJK", time_unit: "seconds" }];
  await act(async () => root.render(<ThreadsViewer />));
  await act(async () => host.querySelector('button[aria-label="Source"]').click());
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
  await act(async () => host.querySelector('[aria-label="Conversation view"] button').click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-level")).toBe("3");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick topic").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-selected")).toBe("topic");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick topic").click());
  expect(host.querySelector('[data-testid="timeline"]').getAttribute("data-selected")).toBe("topic");
});

it("propagates a Source rename to the graph and Discussion before persistence finishes", async () => {
  context.compact=false;
  await act(async()=>root.render(<ThreadsViewer/>));
  await act(async()=>host.querySelector('button[aria-label="Source"]').click());
  context.holdSave=true;
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==="Apply fixture name").click());
  expect(host.querySelector('[data-testid="graph-speaker-name"]').textContent).toBe("Reviewed alias");
  expect(host.querySelector('[data-testid="text-source"]').textContent).toContain("Reviewed alias");
  expect(context.bundle.utterances[0].speaker_name).toBe("Speaker Alpha");
  await act(async()=>host.querySelector('[aria-label="Conversation view"] button').click());
  expect(host.querySelector('[aria-label="Speaker colors"]').textContent).toContain("Reviewed alias");
});
