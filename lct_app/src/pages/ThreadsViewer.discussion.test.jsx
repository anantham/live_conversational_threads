import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { straightTree, utterances } from "../components/discussion/discussionFixtures";

const context = vi.hoisted(() => ({ compact: false, bundle: null }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn(), useParams: () => ({}), useLocation: () => ({ search: "", state: { threadsBundle: context.bundle } }) }));
vi.mock("../services/dataProvider", () => ({ useDataProvider: () => ({ conversations: {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ COMPACT_VIEWER_QUERY: "", mediaQueryMatches: () => context.compact, useMediaQuery: () => context.compact }));
vi.mock("../services/threadsArtifact", () => ({ validateThreadsArtifact: (value) => value, flattenThreadsGraph: (value) => value.flat(), readThreadsFile: vi.fn() }));
vi.mock("../services/threadsLibraryStore", () => ({ rememberThreadsArtifact: async () => ({ id: "fixture" }), getThreadsLibraryRecord: vi.fn(), getThreadsLibraryRecordByDriveFileId: vi.fn() }));
vi.mock("../components/MinimalGraph", () => ({ default: () => <div data-testid="graph">Graph fixture</div> }));
vi.mock("../components/MinimalLegend", () => ({ default: () => null }));
vi.mock("../components/NodeDetail", () => ({ default: () => null }));
vi.mock("../components/TimelineRibbon", () => ({ default: () => null }));
vi.mock("../components/threads/YouTubeSourcePanel", () => ({ default: () => null }));
vi.mock("../components/threads/DriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/PublicDriveThreadsGate", () => ({ default: () => null }));
vi.mock("../components/threads/MobileConversationDeck", () => ({ default: () => <div>Cards fixture</div> }));
import ThreadsViewer from "./ThreadsViewer";
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; window.__MG_DEBUG__ = false;
  context.bundle = { version: 1, conversation_title: "Synthetic conversation", graph_data: [straightTree], utterances, edges: [] };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
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
