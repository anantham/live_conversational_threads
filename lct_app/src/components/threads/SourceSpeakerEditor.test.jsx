import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourceSpeakerEditor from "./SourceSpeakerEditor";

// Test intent: names stay attached to stable speaker IDs; sample cues seek to
// timestamped utterances; reviewed export serializes the supplied bundle.
let container;
let root;
const bundle = { utterances: [
  { id: "a", speaker_id: "SPEAKER_00", timestamp_start: 10, text: "First sample" },
  { id: "b", speaker_id: "SPEAKER_01", timestamp_start: 20, text: "Second speaker sample" },
  { id: "c", speaker_id: "SPEAKER_00", timestamp_start: 30, text: "Another sample" },
  { id: "d", speaker_id: "SPEAKER_00", timestamp_start: 40, text: "Third sample" },
  { id: "e", speaker_id: "SPEAKER_00", timestamp_start: 50, text: "Not shown" },
] };

it("shows words from untimed speakers without inert seek controls", () => {
  act(() => root.render(<SourceSpeakerEditor bundle={{utterances:[{id:'untimed',speaker_id:'SPEAKER_00',text:'Untimed source context'}]}} onRenameSpeaker={vi.fn()} />));
  expect(container.textContent).toContain('Untimed source context');
  expect(container.textContent).not.toContain('Go to sample');
  expect(container.querySelector('input[aria-label="Speaker name"]')).not.toBeNull();
});
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows selected speaker context and cues the chosen timestamp", () => {
  const onSeek = vi.fn();
  act(() => root.render(<SourceSpeakerEditor bundle={bundle} onRenameSpeaker={vi.fn()} onSeek={onSeek} />));
  expect(container.querySelector("summary").textContent).toBe("Name the speakers");
  container.querySelector("details").open = true;
  expect(container.textContent).toContain("Speaker 1");
  expect(container.textContent).toContain("First sample");
  expect(container.textContent).toContain("Third sample");
  expect(container.textContent).not.toContain("Not shown");
  expect(container.querySelectorAll('[aria-label="Selected speaker passages"] button')).toHaveLength(3);
  const sampleButton = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Go to sample"));
  act(() => sampleButton.click());
  expect(onSeek).toHaveBeenCalledWith(10);
  act(() => { container.querySelector("select").value = "SPEAKER_01"; container.querySelector("select").dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("Second speaker sample");
});

it("saves a trimmed name by stable speaker ID and exports the unchanged input bundle", async () => {
  const onRenameSpeaker = vi.fn();
  const createObjectURL = vi.fn(() => "blob:reviewed");
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  act(() => root.render(<SourceSpeakerEditor bundle={bundle} onRenameSpeaker={onRenameSpeaker} onSeek={vi.fn()} />));
  container.querySelector("details").open = true;
  const input = container.querySelector('[aria-label="Speaker name"]');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "  Ada  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onRenameSpeaker).toHaveBeenCalledWith("SPEAKER_00", "Ada");
  expect(bundle.utterances[0].speaker_name).toBeUndefined();
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Download reviewed"))?.click());
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(anchorClick).toHaveBeenCalledOnce();
});
