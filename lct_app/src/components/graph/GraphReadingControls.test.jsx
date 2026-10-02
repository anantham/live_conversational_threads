import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import GraphReadingControls from "./GraphReadingControls";

/*
 * Test intent:
 * - The center controls explain reading order for the selected thread or conversation.
 * - Boundary controls expose first/last reasons while remaining truly disabled.
 * - Available Previous/Next controls preserve accessible names, count, and callbacks.
 */

let host;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

async function renderControls(props) {
  await act(async () => {
    root.render(<GraphReadingControls {...props} />);
  });
}

async function focusAndReadTooltip(element) {
  await act(async () => element.focus());
  return document.querySelector('[role="tooltip"]')?.textContent;
}

it("explains selected-thread reading and the first/last boundaries", async () => {
  const onPrevious = vi.fn();
  const onNext = vi.fn();
  const props = { navigationScope: "selected thread", readingIndex: 0, readingPathLength: 3, onPrevious, onNext };
  await renderControls(props);

  const nav = host.querySelector('nav[aria-label="Selected thread reading controls"]');
  const previous = nav.querySelector('button[aria-label="Previous moment in selected thread"]');
  const next = nav.querySelector('button[aria-label="Next moment in selected thread"]');
  expect(nav.textContent).toContain("1 of 3");
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  expect(await focusAndReadTooltip(previous.parentElement)).toBe(
    "Previous moment in this thread. Follows the thread’s moments. Left arrow key. You’re at the first moment.",
  );
  await act(async () => next.click());
  expect(onPrevious).not.toHaveBeenCalled();
  expect(onNext).toHaveBeenCalledTimes(1);

  await renderControls({ ...props, readingIndex: 2 });
  expect(nav.textContent).toContain("3 of 3");
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(true);
  expect(await focusAndReadTooltip(next.parentElement)).toBe(
    "Next moment in this thread. Follows the thread’s moments. Right arrow key. You’re at the last moment.",
  );
  await act(async () => previous.click());
  expect(onPrevious).toHaveBeenCalledTimes(1);
});

it("explains conversation order and preserves the unknown-position count", async () => {
  const onPrevious = vi.fn();
  const onNext = vi.fn();
  await renderControls({ navigationScope: "conversation", readingIndex: -1, readingPathLength: 3, onPrevious, onNext });

  const nav = host.querySelector('nav[aria-label="Conversation reading controls"]');
  const previous = nav.querySelector('button[aria-label="Previous moment in conversation"]');
  const next = nav.querySelector('button[aria-label="Next moment in conversation"]');
  expect(nav.textContent).toContain("3 moments");
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(false);
  expect(await focusAndReadTooltip(previous)).toBe(
    "Previous moment in this conversation. Follows the conversation order. Left arrow key.",
  );
  expect(await focusAndReadTooltip(next)).toBe(
    "Next moment in this conversation. Follows the conversation order. Right arrow key.",
  );
  await act(async () => previous.click());
  await act(async () => next.click());
  expect(onPrevious).toHaveBeenCalledTimes(1);
  expect(onNext).toHaveBeenCalledTimes(1);
});
