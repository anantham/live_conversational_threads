import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { straightTree, utterances } from "./discussionFixtures";
const fetchTranscript = vi.hoisted(() => vi.fn());
vi.mock("../../services/transcriptReviewApi", () => ({ fetchTranscriptReview: (...args) => fetchTranscript(...args), correctTranscriptText: vi.fn() }));
import SavedDiscussionView from "./SavedDiscussionView";
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; fetchTranscript.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; vi.useRealTimers(); });
const click = async (text) => act(async () => [...host.querySelectorAll("button")].find((value) => value.textContent.includes(text)).click());
it("shows a real elapsed wait, retains hierarchy on failure and retries exact utterances", async () => {
  vi.useFakeTimers();
  let reject;
  fetchTranscript.mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail; }));
  await act(async () => root.render(<SavedDiscussionView conversationId="synthetic" nodes={straightTree} />));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.querySelector('[role="status"]').textContent).toContain("2s elapsed · Time remaining unknown");
  expect(host.textContent).toContain("Topic A");
  await click("Topic A"); await click("Idea A"); await click("Moment A");
  expect(host.textContent).toContain("Loading exact words");
  await act(async () => reject(new Error("Synthetic transcript failure")));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Synthetic transcript failure");
  expect(host.textContent).toContain("Exact words unavailable");
  fetchTranscript.mockResolvedValueOnce({ utterances });
  await click("Retry transcript");
  expect(host.querySelector('[data-utterance-id="u1"]').textContent).toContain(utterances[0].text);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("aborts waiting when leaving the saved discussion", async () => {
  let signal;
  fetchTranscript.mockImplementation((id, value) => { signal = value; return new Promise(() => {}); });
  await act(async () => root.render(<SavedDiscussionView conversationId="synthetic" nodes={straightTree} />));
  expect(signal.aborted).toBe(false);
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});
it("offers a stop control that cancels and exposes retry", async () => {
  fetchTranscript.mockImplementation((id, signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
  await act(async () => root.render(<SavedDiscussionView conversationId="synthetic" nodes={straightTree} />));
  await click("Stop waiting");
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain("Retry transcript");
});
