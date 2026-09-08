/* Test intent: collapsed, node-scoped source review disclosure on real desktop
 * and mobile detail paths; model text stays plain, policies and question states
 * stay separate, and changing nodes closes the disclosure. The selector itself
 * is covered independently; this fixture doubles only its normalized output.
 */
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourceReviewDetails from "./SourceReviewDetails";
import NodeDetail from "../NodeDetail";
import MobileConversationDeck from "./MobileConversationDeck";

vi.mock("../../services/sourceReviews", async (importOriginal) => {
  const actual = await importOriginal();
  return { selectSourceReviews: (bundle, nodeId) => bundle?.testReviews?.[nodeId] || actual.selectSourceReviews(bundle, nodeId) };
});

const quote = '<img src=x onerror="alert(1)"> Who may borrow?';
const reviews = {
  questions: [{ id: "q1", policyFingerprint: "policy-one", originalWording: "Who may borrow?",
    provisionalStatus: "answered", status: "open", rationale: "An aside did not answer the inquiry.",
    evidence: [{ nodeId: "a", sourceId: "source-0", quote, utteranceIds: ["u1"] }] }],
  threads: [{ pair: ["a", "b"], policyFingerprint: "policy-two", judgment: "uncertain",
    rationale: "The return is uncertain.", evidence: [{ nodeId: "a", sourceId: "source-0", quote }] }],
  invalidCount: 0,
};
const bundle = { testReviews: { a: reviews, b: reviews }, utterances: [], graph_data: [] };
let root; let container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});
function toggle() {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Source reviews"));
  expect(button).toBeTruthy();
  act(() => button.click());
  return button;
}

it("commits a changed node collapsed before layout effects can observe it", () => {
  // Test intent: no expanded content from a previous selection reaches paint.
  // act() alone flushes passive effects and would hide this regression.
  const observed = [];
  function Observe({ nodeId, currentBundle = bundle }) {
    useLayoutEffect(() => {
      observed.push(container.querySelector("button")?.getAttribute("aria-expanded"));
    });
    return <SourceReviewDetails bundle={currentBundle} nodeId={nodeId} />;
  }
  act(() => root.render(<Observe nodeId="a" />));
  toggle();
  act(() => root.render(<Observe nodeId="b" />));
  expect(observed.at(-1)).toBe("false");
  toggle();
  act(() => root.render(<Observe nodeId="b" currentBundle={{ ...bundle }} />));
  expect(observed.at(-1)).toBe("false");
});

it("starts collapsed, separates policies/statuses, escapes source text and resets on node change", () => {
  act(() => root.render(<SourceReviewDetails bundle={bundle} nodeId="a" />));
  expect(container.textContent).not.toContain(quote);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Model interpretation, not human-verified");
  expect(container.textContent).toContain("Originally recorded: answered");
  expect(container.textContent).toContain("Reviewed: open");
  expect(container.textContent).toContain("policy-one");
  expect(container.textContent).toContain("policy-two");
  expect(container.textContent).toContain("uncertain");
  expect(container.textContent).toContain(quote);
  expect(container.querySelector("img")).toBeNull();
  act(() => root.render(<SourceReviewDetails bundle={bundle} nodeId="b" />));
  expect(container.querySelector("button").getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain(quote);
});

it("is reachable through desktop NodeDetail without backend identity", () => {
  act(() => root.render(<NodeDetail node={{ id: "a", node_name: "Key inquiry" }}
    reviewBundle={bundle} onClose={() => {}} />));
  expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  toggle();
  expect(container.textContent).toContain("An aside did not answer the inquiry.");
});

it("is reachable in the mobile card and its disclosure is not a deck gesture", () => {
  act(() => root.render(<MobileConversationDeck bundle={bundle}
    graphNodes={[{ id: "a", node_name: "Key inquiry", summary: "Unresolved", semantic_level: 1 }]}
    onDownloadTranscript={() => {}} onOpenAnother={() => {}} onOpenLibrary={() => {}} onShowMap={() => {}} />));
  const card = container.querySelector('[data-testid="mobile-deck-card"]');
  expect(card).toBeTruthy();
  toggle();
  expect(card.textContent).toContain("The return is uncertain.");
  expect(card.querySelector("details")).toBeNull();
});

it("does not add chrome when there are no reviews", () => {
  act(() => root.render(<SourceReviewDetails bundle={{}} nodeId="a" />));
  expect(container.textContent).toBe("");
});

it.each(["desktop", "mobile"])("renders a real artifact through the selector and %s detail path", (layout) => {
  const nodes = ["a", "b"].map((id) => ({ id, chunk_id: "c", thread_id: "key", semantic_level: 1,
    node_name: `Moment ${id}`, summary: "An inquiry" }));
  const actualBundle = { graph_data: nodes, utterances: [{ id: "u", text: quote }],
    thread_identity_reviews: { schema_version: 1, policies: [{ policy_fingerprint: "actual-policy", annotations: [{
      pair: ["a", "b"], judgment: "uncertain", rationale: "Insufficient context.", accepted_for_projection: false,
      nodes: nodes.map((n) => ({ node_id: n.id, thread_id: "key", source_id: "s" })),
      sources: [{ source_id: "s", chunk_id: "c", utterance_ids: ["u"], text: quote }],
      evidence: nodes.map((n) => ({ node_id: n.id, source_id: "s", quote, start: 0, end: Array.from(quote).length })),
    }] }] } };
  act(() => root.render(layout === "desktop"
    ? <NodeDetail node={nodes[0]} reviewBundle={actualBundle} onClose={() => {}} />
    : <MobileConversationDeck bundle={actualBundle} graphNodes={nodes}
      onDownloadTranscript={() => {}} onOpenAnother={() => {}} onOpenLibrary={() => {}} onShowMap={() => {}} />));
  toggle();
  expect(container.textContent).toContain("actual-policy");
  expect(container.textContent).toContain(quote);
  expect(container.querySelector("img")).toBeNull();
});
