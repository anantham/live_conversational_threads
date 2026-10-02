import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TextSourcePanel from "./TextSourcePanel";
import { renameArtifactSpeaker } from "../../services/youtubeMedia";

// Test intent: untimed source results reveal original bytes and scroll the
// selected exact transcript range or utterance into view without external work.
// Unverified recording metadata explains why text is shown and never becomes a link.
let host, root, scroll;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  scroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  if (scroll) HTMLElement.prototype.scrollIntoView = scroll;
  else delete HTMLElement.prototype.scrollIntoView;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

it("preserves full transcript whitespace and marks the original selected range", () => {
  const full = "Opening  words\n  exact passage\tcontinues\nEnding";
  const start = full.indexOf("exact passage");
  const end = start + "exact passage\tcontinues".length;
  act(() => root.render(<TextSourcePanel bundle={{ full_transcript: full, utterances: [{ id: "partial", text: "Opening words" }] }} selection={{ kind: "transcript", start, end }} onClose={vi.fn()} />));
  expect(host.querySelector("pre").textContent).toBe(full);
  expect(host.querySelector("mark").textContent).toBe(full.slice(start, end));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("reveals an untimed utterance in its original passage list", () => {
  const bundle = { full_transcript: "Full source also exists", utterances: [{ id: "u-1", speaker_name: "Ada", text: "First line\nSecond  line" }] };
  act(() => root.render(<TextSourcePanel bundle={bundle} selection={{ kind: "utterance", utteranceId: "u-1" }} compact onClose={vi.fn()} />));
  const selected = host.querySelector('[aria-current="true"]');
  expect(selected.textContent).toContain("First line\nSecond  line");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
});

it("explains an unverified recording while retaining the original text",()=>{
 const text="Synthetic original source";
 act(()=>root.render(<TextSourcePanel bundle={{full_transcript:text,media_refs:[{provider:"youtube",video_id:"ABCDEFGHIJK",view_url:"https://invalid.example",time_unit:"seconds"}]}}/>));
 expect(host.querySelector('[role="status"]').textContent).toContain("YouTube source unavailable");
 expect(host.querySelector('pre').textContent).toBe(text);
 expect(host.querySelector('a')).toBeNull();
});

it("updates recognized speaker labels twice while selection and source bytes remain exact", () => {
  const full = "[SPEAKER_00] First  phrase\r\n[SPEAKER_01] SPEAKER_00 appears in speech\n[00:00:03.000] SPEAKER_00: Final phrase\n[UNKNOWN] Unmapped";
  const original = {
    full_transcript: full,
    utterances: [
      { id: "u0", speaker_id: "SPEAKER_00", text: "First  phrase", timestamp_start: 1 },
      { id: "u1", speaker_id: "SPEAKER_01", text: "SPEAKER_00 appears in speech", timestamp_start: 2 },
    ],
    graph_data: [[{ id: "n0", speaker_id: "SPEAKER_00" }]],
  };
  const selected = "SPEAKER_00 appears in speech";
  const start = full.indexOf(selected);
  const selection = { kind: "transcript", start, end: start + selected.length };
  const render = (bundle) => act(() => root.render(<TextSourcePanel bundle={bundle} selection={selection} onClose={vi.fn()} />));
  render(original);
  expect(host.querySelector("pre").textContent).toBe(full);
  const first = renameArtifactSpeaker(original, "SPEAKER_00", "Ada");
  render(first);
  expect(host.querySelector("pre").textContent).toBe("[Ada] First  phrase\r\n[SPEAKER_01] SPEAKER_00 appears in speech\n[00:00:03.000] Ada: Final phrase\n[UNKNOWN] Unmapped");
  expect(host.querySelector("mark").textContent).toBe(full.slice(start, selection.end));
  const second = renameArtifactSpeaker(first, "SPEAKER_00", "A. Rao");
  render(second);
  expect(host.querySelector("pre").textContent).toContain("[A. Rao] First  phrase");
  expect(host.querySelector("pre").textContent).toContain("[00:00:03.000] A. Rao: Final phrase");
  expect(host.querySelector("mark").textContent).toBe(selected);
  expect(second.full_transcript).toBe(full);
  expect(second.utterances.map(({ speaker_id }) => speaker_id)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
  expect(second.utterances.map(({ timestamp_start }) => timestamp_start)).toEqual([1, 2]);
  act(() => host.querySelector('button[aria-pressed="false"]').click());
  expect(host.querySelector("[aria-label='Original source passages']").textContent).toContain("A. RaoFirst  phrase");
});
