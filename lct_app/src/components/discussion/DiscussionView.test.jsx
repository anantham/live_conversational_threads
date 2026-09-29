import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(button("Right branch").querySelector(".sr-only").textContent).toBe("Speakers: Speaker Alpha");
    click("Right branch"); click("shared branch");
    expect(host.querySelectorAll('[data-discussion-node="shared"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-utterance-id="u1"]')).toHaveLength(1);
    expect(document.activeElement).toBe(button("Shared moment"));
    expect(button("Left branch").getAttribute("aria-expanded")).toBe("true");
  });
  it("makes one exchange reachable from three authored ideas", () => {
    const ideas = ["First idea", "Second idea", "Third idea"].map((name, index) => ({
      id: `idea-${index}`, semantic_level: 2, node_name: name, children_ids: ["one-moment"],
    }));
    const moment = { id: "one-moment", semantic_level: 1, node_name: "One exchange", parent_id: "idea-0",
      memberships: ideas.map((idea, index) => ({ parent_id: idea.id, role: index ? "secondary" : "primary" })), utterance_ids: ["u1"] };
    act(() => root.render(<DiscussionView nodes={[...ideas, moment]} utterances={utterances} />));
    ideas.forEach((idea) => expect(button(idea.node_name).querySelector(".sr-only").textContent).toBe("Speakers: Speaker Alpha"));
    click("Third idea"); click("shared branch");
    expect(host.querySelectorAll('[data-discussion-node="one-moment"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-utterance-id="u1"]')).toHaveLength(1);
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
  it("shows speaker identities on collapsed branches and lets an artifact owner name them", () => {
    const rows = [
      { id: "first", speaker_id: "SPEAKER_00", text: "First synthetic line" },
      { id: "second", speaker_id: "SPEAKER_01", text: "Second synthetic line" },
    ];
    const tree = [{ id: "exchange", semantic_level: 1, node_name: "Shared exchange", utterance_ids: ["first", "second"] }];
    const rename = vi.fn();
    act(() => root.render(<DiscussionView nodes={tree} utterances={rows} onRenameSpeaker={rename} />));
    const legend = host.querySelector('[aria-label="Speaker colors"]');
    expect(legend.textContent).toContain("Speaker 1");
    expect(legend.textContent).toContain("Speaker 2");
    expect(legend.textContent).not.toContain("SPEAKER_00");
    expect(legend.querySelectorAll('[aria-hidden="true"]')[0].style.backgroundColor)
      .not.toBe(legend.querySelectorAll('[aria-hidden="true"]')[1].style.backgroundColor);
    act(() => root.render(<DiscussionView nodes={tree} utterances={rows} speakerColorMap={{ SPEAKER_01: "#7dd3fc" }} onRenameSpeaker={rename} />));
    expect(legend.querySelectorAll('[aria-hidden="true"]')[0].style.backgroundColor)
      .not.toBe(legend.querySelectorAll('[aria-hidden="true"]')[1].style.backgroundColor);
    expect(button("Shared exchange").querySelector(".sr-only").textContent).toBe("Speakers: Speaker 1, Speaker 2");
    click("Shared exchange");
    expect(host.querySelector('[data-utterance-id="first"]').textContent).toContain("Speaker 1");
    act(() => host.querySelector("summary").click());
    const input = host.querySelector("input");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Example Person");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(rename).toHaveBeenCalledWith("SPEAKER_00", "Example Person");
    act(() => root.render(<DiscussionView nodes={tree} utterances={[{ ...rows[0], speaker_name: "Example Person" }, rows[1]]} onRenameSpeaker={rename} />));
    expect(host.querySelector('[aria-label="Speaker colors"]').textContent).toContain("Example Person");
    expect(host.querySelector('[data-utterance-id="first"]').textContent).toContain("Example Person");
  });
  it("keeps an explicit speaker name when the transcript has no diarization ID", () => {
    act(() => root.render(<DiscussionView nodes={[]} utterances={[{ id: "named", speaker_name: "Example Person", text: "Named line" }]} />));
    act(() => host.querySelector("summary").click());
    expect(host.querySelector('[data-utterance-id="named"]').textContent).toContain("Example Person");
    expect(host.querySelector('[data-utterance-id="named"] [aria-hidden="true"]').textContent).toBe("EP");
  });
  it("does not invent structure for transcript-only or empty conversations", () => {
    act(() => root.render(<DiscussionView nodes={[]} utterances={utterances} />));
    expect(host.textContent).toContain("Transcript passages (1)");
    expect(host.querySelector('[data-utterance-id="u1"]').textContent).toContain(utterances[0].text);
    act(() => root.render(<DiscussionView nodes={[]} />));
    expect(host.textContent).toContain("No discussion structure or retained utterances yet.");
  });

  it("labels each semantic branch and opens a deep-linked branch", () => {
    const previousHash = window.location.hash;
    window.location.hash = "#discussion=moment";
    try {
      act(() => root.render(<DiscussionView nodes={straightTree} utterances={utterances} />));
      expect(button("Topic A").textContent).toContain("Topic 1");
      expect(button("Idea A").textContent).toContain("Idea 1");
      expect(button("Moment A").textContent).toContain("Moment 1");
      expect(button("Topic A").getAttribute("aria-expanded")).toBe("true");
      expect(button("Idea A").getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelector('[data-utterance-id="u1"]')).not.toBeNull();
    } finally {
      window.location.hash = previousHash;
    }
  });

  it("copies a stable branch link and tints exact words by speaker", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    act(() => root.render(<DiscussionView nodes={straightTree} utterances={utterances}
      speakerColorMap={{ "speaker-a": "#7dd3fc" }}
      linkBase="https://example.test/view?src=synthetic.threads" />));
    const link = host.querySelector('button[aria-label^="Copy link to Topic 1"]');
    expect(link).not.toBeNull();
    await act(async () => { link.click(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith("https://example.test/view?src=synthetic.threads#discussion=topic");
    click("Topic A"); click("Idea A"); click("Moment A");
    expect(host.querySelector('[data-utterance-id="u1"]').style.backgroundColor).toBe("rgba(125, 211, 252, 0.1)");
    expect(host.querySelector('[role="status"]').textContent).toContain("link copied");
    await act(async () => { link.click(); await Promise.resolve(); });
    expect(host.querySelector('[role="status"]').textContent).toContain("again (2 copies)");
    writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
    await act(async () => { link.click(); await Promise.resolve(); });
    expect(host.querySelector('[role="status"]').textContent).toContain("https://example.test/view?src=synthetic.threads#discussion=topic");
    vi.unstubAllGlobals();
  });

  it("does not steal focus again when the linked model or unchanged request rerenders", () => {
    const previousHash = window.location.hash;
    window.history.replaceState(null, "", "#discussion=moment");
    try {
      act(() => root.render(<DiscussionView nodes={straightTree} utterances={utterances} focusRequest={{ id: "moment", requestKey: 1 }} />));
      const other = button("Topic A");
      act(() => other.focus());
      act(() => root.render(<DiscussionView nodes={straightTree.map((node) => ({ ...node }))}
        utterances={[...utterances]} focusRequest={{ id: "moment", requestKey: 1 }} />));
      expect(document.activeElement).toBe(other);
    } finally {
      window.history.replaceState(null, "", previousHash || window.location.pathname);
    }
  });
});
