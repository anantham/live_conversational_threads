import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MobileConversationDeck from "./MobileConversationDeck";

/*
 * Test intent:
 * - The compact viewer presents one readable highest-tier card and exposes non-gesture navigation.
 * - Repeated drill actions reach a real artifact utterance with speaker, timestamp, and media deep link.
 * - Up returns to the exact parent rather than resetting the conversation branch.
 * - The More sheet contains secondary actions and truthfully explains an absent authored tier.
 * - Modal focus pauses global arrow shortcuts; focused navigation buttons retain them.
 * - Focused cards use their visible title as their accessible name.
 * - Boundary controls remain operable for explanatory notices without claiming to be disabled.
 * - More notices remain exposed to assistive technology outside the inert deck background.
 * - Live mode follows the newest branch, pins when moving backward, and exposes a direct return-to-live action.
 * - Historical artifacts retain the same deck without live-only status chrome.
 */

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

function fixture({ includeTheme = true } = {}) {
  const utterance = {
    id: "u1",
    sequence_number: 1,
    speaker_id: "speaker-a",
    speaker_name: "Aayush",
    timestamp_start: 12,
    timestamp_end: 18,
    text: "The exact words remain available here.",
  };
  const nodes = [
    {
      id: "topic-1",
      semantic_level: 3,
      node_name: "Traceable topic",
      summary: "A topic that remains grounded.",
      parent_id: includeTheme ? "theme-1" : null,
      children_ids: ["idea-1"],
    },
    {
      id: "idea-1",
      semantic_level: 2,
      node_name: "Traceable idea",
      summary: "An idea with one source moment.",
      parent_id: "topic-1",
      children_ids: ["moment-1"],
    },
    {
      id: "moment-1",
      semantic_level: 1,
      node_name: "Traceable moment",
      summary: "A moment linked to exact words.",
      parent_id: "idea-1",
      children_ids: [],
      source_ref: { utterance_ids: ["u1"] },
      provenance_utterance_ids: ["u1"],
      provenance_metrics: {
        word_count: 7,
        matched_utterance_count: 1,
        duration_seconds: 6,
      },
    },
  ];
  if (includeTheme) {
    nodes.unshift(
      {
        id: "arc-1",
        semantic_level: 5,
        node_name: "Traceable arc",
        summary: "The conversation’s broadest authored shape.",
        children_ids: ["theme-1"],
      },
      {
        id: "theme-1",
        semantic_level: 4,
        node_name: "Traceable theme",
        summary: "A theme containing the selected topic.",
        parent_id: "arc-1",
        children_ids: ["topic-1"],
      },
    );
  }
  return {
    bundle: {
      conversation_title: "Mobile deck fixture",
      utterances: [utterance],
      media_refs: [{
        provider: "google_drive",
        file_id: "recording123",
        view_url: "https://drive.google.com/file/d/recording123/view",
      }],
    },
    nodes,
  };
}

function renderDeck(options = {}) {
  const { bundle, nodes } = fixture(options);
  const callbacks = {
    onDownloadTranscript: vi.fn(),
    onOpenAnother: vi.fn(),
    onOpenLibrary: vi.fn(),
    onShowMap: vi.fn(),
  };
  act(() => {
    root.render(
      <MobileConversationDeck
        bundle={bundle}
        graphNodes={nodes}
        libraryStatus={{ state: "saved", message: "Saved on this device" }}
        {...callbacks}
      />,
    );
  });
  return callbacks;
}

function clickByLabel(label) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("MobileConversationDeck", () => {
  it("drills from the highest tier to exact timed evidence and returns to its parent", () => {
    renderDeck();
    expect(container.textContent).toContain("Traceable arc");
    const arcCard = container.querySelector('[data-testid="mobile-deck-card"]');
    expect(arcCard?.dataset.level).toBe("5");
    const arcHeading = arcCard?.querySelector("h2");
    expect(arcCard?.hasAttribute("aria-label")).toBe(false);
    expect(arcCard?.getAttribute("aria-labelledby")).toBe(arcHeading?.id);
    expect(arcHeading?.textContent).toBe("Traceable arc");

    const up = container.querySelector('button[aria-label="Move to a higher level of abstraction"]');
    expect(up?.hasAttribute("aria-disabled")).toBe(false);
    act(() => up.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("You are already at the highest available level.");

    for (let depth = 0; depth < 5; depth += 1) {
      clickByLabel("Drill into a finer level of detail");
    }

    const utteranceCard = container.querySelector('[data-testid="mobile-deck-card"]');
    expect(utteranceCard?.dataset.kind).toBe("utterance");
    const utteranceHeading = utteranceCard?.querySelector("h2");
    expect(utteranceCard?.getAttribute("aria-labelledby")).toBe(utteranceHeading?.id);
    expect(utteranceHeading?.textContent).toBe("Aayush");
    expect(container.textContent).toContain("Aayush");
    expect(container.textContent).toContain("The exact words remain available here.");
    expect(container.textContent).toContain("0:12");
    expect(container.querySelector('a[href="https://drive.google.com/file/d/recording123/view?t=10"]'))
      .not.toBeNull();
    Object.defineProperties(utteranceCard, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    act(() => utteranceCard.focus());
    act(() => utteranceCard.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    })));
    expect(utteranceCard.scrollTop).toBeGreaterThan(0);
    expect(utteranceCard.dataset.kind).toBe("utterance");

    clickByLabel("Move to a higher level of abstraction");
    expect(container.textContent).toContain("Traceable moment");
    expect(container.querySelector('[data-testid="mobile-deck-card"]')?.dataset.level).toBe("1");
  });

  it("moves secondary actions into More and explains a missing theme tier", () => {
    const callbacks = renderDeck({ includeTheme: false });
    expect(container.querySelector('[role="dialog"]')?.closest('[aria-hidden="true"]')).not.toBeNull();
    clickByLabel("More conversation options");

    expect(container.querySelector('[role="dialog"]')?.closest('[aria-hidden="false"]')).not.toBeNull();
    expect(container.textContent).toContain("Download transcript");
    expect(container.textContent).toContain("Saved on this device");
    const themes = [...container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("themes") && button.textContent.includes("none"));
    expect(themes).not.toBeNull();
    act(() => themes.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const notice = container.querySelector('[role="status"]');
    expect(notice?.textContent)
      .toBe("No themes were generated for this conversation.");
    expect(notice?.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(notice?.className).not.toContain("pointer-events-none");

    const transcript = [...container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Download transcript"));
    act(() => transcript.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(callbacks.onDownloadTranscript).toHaveBeenCalledOnce();
  });

  it("pauses arrow shortcuts behind More and keeps them active on focused deck controls", () => {
    renderDeck();
    clickByLabel("More conversation options");
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    expect(container.querySelector('[data-testid="mobile-deck-background"]')?.hasAttribute("inert"))
      .toBe(true);

    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowDown",
    })));
    expect(container.textContent).toContain("Traceable arc");
    expect(container.textContent).not.toContain("Traceable theme");

    clickByLabel("Close");
    expect(container.querySelector('[data-testid="mobile-deck-background"]')?.hasAttribute("inert"))
      .toBe(false);
    const down = container.querySelector('button[aria-label="Drill into a finer level of detail"]');
    act(() => down.focus());
    clickByLabel("Drill into a finer level of detail");
    expect(container.textContent).toContain("Traceable theme");

    act(() => down.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowDown",
    })));
    expect(container.textContent).toContain("Traceable topic");
  });

  it("keeps focus on the chosen More action across parent status rerenders", () => {
    const { bundle, nodes } = fixture();
    const callbacks = {
      onDownloadTranscript: vi.fn(),
      onOpenAnother: vi.fn(),
      onOpenLibrary: vi.fn(),
      onShowMap: vi.fn(),
    };
    const renderWithStatus = (message) => {
      act(() => {
        root.render(
          <MobileConversationDeck
            bundle={bundle}
            graphNodes={nodes}
            libraryStatus={{ state: "saved", message }}
            {...callbacks}
          />,
        );
      });
    };

    renderWithStatus("Saving on this device");
    clickByLabel("More conversation options");
    const library = [...container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Library"));
    expect(library).not.toBeNull();
    act(() => library.focus());

    renderWithStatus("Saved on this device");
    expect(document.activeElement).toBe(library);
  });

  it("pins a live reader without moving them when a newer branch arrives", () => {
    const bundle = { conversation_title: "Live deck", utterances: [], media_refs: [] };
    const callbacks = {
      onDownloadTranscript: vi.fn(),
      onOpenAnother: vi.fn(),
      onOpenLibrary: vi.fn(),
      onShowMap: vi.fn(),
    };
    const liveNodes = [
      { id: "arc-old", semantic_level: 5, timestamp_start: 1, node_name: "Older arc" },
      { id: "arc-live", semantic_level: 5, timestamp_start: 2, node_name: "Current arc" },
    ];
    const renderLive = (graphNodes) => {
      act(() => {
        root.render(
          <MobileConversationDeck
            bundle={bundle}
            graphNodes={graphNodes}
            live
            {...callbacks}
          />,
        );
      });
    };

    renderLive(liveNodes);
    expect(container.textContent).toContain("Current arc");
    expect(container.textContent).toContain("Following live");

    clickByLabel("Previous arc");
    expect(container.textContent).toContain("Older arc");
    expect(container.textContent).toContain("1 update behind");

    renderLive([
      ...liveNodes,
      { id: "arc-new", semantic_level: 5, timestamp_start: 3, node_name: "Newest arc" },
    ]);
    expect(container.textContent).toContain("Older arc");
    expect(container.textContent).toContain("2 updates behind");
    expect(container.textContent).not.toContain("Newest arc");

    clickByLabel("Return to live");
    expect(container.textContent).toContain("Newest arc");
    expect(container.textContent).toContain("Following live");
  });

  it("does not add live status chrome to a historical artifact", () => {
    renderDeck();
    expect(container.textContent).not.toContain("Following live");
    expect(container.querySelector('button[aria-label="Return to live"]')).toBeNull();
  });
});
