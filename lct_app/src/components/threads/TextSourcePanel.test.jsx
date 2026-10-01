import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TextSourcePanel from "./TextSourcePanel";

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
