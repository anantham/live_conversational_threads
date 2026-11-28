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

// Test intent (review fixes, 2026-11-27): the recorded-audio player in the drawer seeks only once the audio
// can take it and then clears the request; the playing turn is marked without stealing the selection's
// scroll; the full transcript offers a way to the passages that follow playback; closing the drawer clears
// the playhead.
const timedBundle = { full_transcript: "A: one\nB: two", utterances: [
  { id: "u1", speaker_id: "A", text: "one", timestamp_start: 0, timestamp_end: 5 },
  { id: "u2", speaker_id: "B", text: "two", timestamp_start: 5, timestamp_end: 9 },
] };
const panel = (props) => <TextSourcePanel bundle={timedBundle} audioUrl="blob:synthetic" onToggleFollowPlayhead={() => {}} onPlayheadTimeUpdate={() => {}} {...props} />;

it("waits for the audio's metadata before seeking, then clears the request", () => {
  const handled = vi.fn();
  act(() => root.render(panel({ audioSeekRequest: { seconds: 5, key: 1 }, onAudioSeekHandled: handled })));
  const audio = host.querySelector("audio");
  expect(handled).not.toHaveBeenCalled();
  Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
  act(() => { audio.dispatchEvent(new Event("loadedmetadata")); });
  expect(audio.currentTime).toBe(5);
  expect(handled).toHaveBeenCalledTimes(1);
});

it("marks the playing turn and still scrolls the selected passage into the centre", () => {
  act(() => root.render(panel({ selection: { kind: "utterance", utteranceId: "u2" }, playheadSeconds: 5, followPlayhead: false })));
  const row = host.querySelector('[data-playhead-active="true"]');
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
});

it("offers to follow in passages from the full transcript, where nothing is marked", () => {
  const onSectionChange = vi.fn(), toggle = vi.fn();
  act(() => root.render(panel({ sectionMode: "transcript", onSectionChange, followPlayhead: false, onToggleFollowPlayhead: toggle, playheadSeconds: 2 })));
  expect(host.textContent).not.toContain("Following playback");
  const button = [...host.querySelectorAll("button")].find((element) => element.textContent === "Follow in passages");
  act(() => button.click());
  expect(onSectionChange).toHaveBeenCalledWith("utterances");
  expect(toggle).toHaveBeenCalledTimes(1);
});

it("clears the page's playhead when the drawer and its player close", () => {
  const update = vi.fn();
  act(() => root.render(panel({ onPlayheadTimeUpdate: update })));
  act(() => root.render(<div />));
  expect(update).toHaveBeenLastCalledWith(null);
});

it("applies a seek requested while the saved audio was still loading, once the player appears", () => {
  const handled = vi.fn(), request = { seconds: 7, key: 2 }; // the same request object across both renders
  act(() => root.render(panel({ audioUrl: "", audioSeekRequest: request, onAudioSeekHandled: handled })));
  expect(handled).not.toHaveBeenCalled();
  act(() => root.render(panel({ audioUrl: "blob:synthetic", audioSeekRequest: request, onAudioSeekHandled: handled })));
  const audio = host.querySelector("audio");
  Object.defineProperty(audio, "readyState", { configurable: true, value: 1 });
  act(() => { audio.dispatchEvent(new Event("loadedmetadata")); });
  expect(audio.currentTime).toBe(7);
  expect(handled).toHaveBeenCalled();
});

it("scrolls to the playing turn, not the old selection, when asked to follow in passages", () => {
  const calls = [];
  HTMLElement.prototype.scrollIntoView = vi.fn(function record() { calls.push(this.getAttribute("data-playhead-active") ? "playing" : "selected"); });
  act(() => root.render(panel({ sectionMode: "transcript", selection: { kind: "utterance", utteranceId: "u1" }, playheadSeconds: 6, followPlayhead: true })));
  calls.length = 0;
  act(() => root.render(panel({ sectionMode: "utterances", selection: { kind: "utterance", utteranceId: "u1" }, playheadSeconds: 6, followPlayhead: true })));
  expect(calls.at(-1)).toBe("playing");
});
