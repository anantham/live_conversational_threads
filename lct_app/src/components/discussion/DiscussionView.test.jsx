import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DiscussionView from "./DiscussionView";
import { straightTree, sharedTree, sparseTree, utterances } from "./discussionFixtures";

// Test intent: tests/intent/discussion-view.md. No private conversation content.
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
const button = (text) => [...host.querySelectorAll("button")].find((value) => value.textContent.includes(text));
const click = (text) => act(() => button(text).click());

describe("Discussion semantic hierarchy", () => {
  it("expands the straight tree to exact words and collapses through accessible controls", () => {
    act(() => root.render(<DiscussionView nodes={straightTree} utterances={utterances} speakerColorMap={{ "speaker-a": "#7dd3fc" }} />));
    expect(host.textContent).not.toContain("Fixture passage");
    expect(button("Topic A").getAttribute("aria-expanded")).toBe("false");
    click("Topic A"); click("Idea A"); click("Moment A");
    const passage = host.querySelector('[data-utterance-id="u1"]');
    expect(passage.textContent).toContain(utterances[0].text);
    expect(passage.textContent).toContain("Speaker Alpha");
    expect(passage.querySelector('[aria-hidden="true"]').textContent).toBe("SA");
    expect(passage.querySelector('[aria-hidden="true"]').style.backgroundColor).toBe("rgb(125, 211, 252)");
    expect(document.getElementById(button("Moment A").getAttribute("aria-controls"))).not.toBeNull();
    click("Topic A");
    expect(host.querySelector('[data-utterance-id="u1"]')).toBeNull();
  });
  it("opens a shared branch at its canonical location without duplicating its subtree", () => {
    act(() => root.render(<DiscussionView nodes={sharedTree} utterances={utterances} />));
    click("Right branch"); click("shared branch");
    expect(host.querySelectorAll('[data-discussion-node="shared"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-utterance-id="u1"]')).toHaveLength(1);
    expect(document.activeElement).toBe(button("Shared moment"));
    expect(button("Left branch").getAttribute("aria-expanded")).toBe("true");
  });
  it("keeps disconnected tiers and unlinked rows while explaining absent exact words", () => {
    act(() => root.render(<DiscussionView nodes={sparseTree} utterances={[...utterances, { id: "empty", speaker_id: "speaker-b", text: "" }]} />));
    expect(button("Isolated arc")).toBeTruthy();
    click("Isolated moment");
    expect(host.textContent).toContain("No linked utterances are available");
    expect(host.textContent).toContain("Other transcript passages (2)");
    expect(host.querySelector('[data-utterance-id="empty"]').textContent).toContain("Exact utterance text unavailable.");
    expect(host.querySelector('[data-utterance-id="empty"]').textContent).not.toContain("Generated summary");
  });
  it("renders a numeric speaker identifier as a readable label", () => {
    act(() => root.render(<DiscussionView nodes={[]} utterances={[{ id: "numeric", speaker_id: 42, text: "Synthetic line" }]} />));
    act(() => host.querySelector("summary").click());
    expect(host.querySelector('[data-utterance-id="numeric"]').textContent).toContain("42");
  });
  it("does not invent structure for transcript-only or empty conversations", () => {
    act(() => root.render(<DiscussionView nodes={[]} utterances={utterances} />));
    expect(host.textContent).toContain("Transcript passages (1)");
    expect(host.querySelector('[data-utterance-id="u1"]').textContent).toContain(utterances[0].text);
    act(() => root.render(<DiscussionView nodes={[]} />));
    expect(host.textContent).toContain("No discussion structure or retained utterances yet.");
  });
});
