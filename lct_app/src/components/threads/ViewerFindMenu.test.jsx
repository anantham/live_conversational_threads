import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ViewerFindMenu from "./ViewerFindMenu";

// Test intent:
// - Real typing returns lexical matches immediately and semantic requests receive indexed documents.
// - Semantic progress, cancellation, close cleanup, errors, retry, and result selection remain understandable.
let container;
let root;
let workers;
const documents = [
  { key: "utterance:u1", id: "utterance:u1:0", kind: "utterance", utteranceId: "u1", seconds: 12, title: "Mira", text: "First launch detail" },
  { key: "node:n2", id: "node:n2:0", kind: "node", nodeId: "n2", title: "Launch plan", text: "Detailed planning" },
];

class SyntheticWorker {
  constructor() {
    this.messages = [];
    this.postMessage = vi.fn((message) => this.messages.push(message));
    this.terminate = vi.fn();
    workers.push(this);
  }
  emit(message) {
    act(() => this.onmessage?.({ data: { requestId: this.messages.at(-1).requestId, ...message } }));
  }
}

function renderFind(overrides = {}) {
  const props = { groups: [], onSelect: vi.fn(), documents, ...overrides };
  act(() => root.render(<ViewerFindMenu {...props} />));
  return props;
}
function openFind() {
  act(() => container.querySelector("summary").click());
  return container.querySelector("input[type=search]");
}
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() { act(() => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  workers = [];
  vi.stubGlobal("Worker", SyntheticWorker);
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

describe("ViewerFindMenu", () => {
  it("shows lexical results while typing and reports semantic progress until cancelled", () => {
    renderFind();
    const input = openFind();
    type(input, "launch");
    expect(container.textContent).toContain("Text matches · 2");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    submit();
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).toHaveBeenCalledOnce();
    expect(workers[0].messages[0]).toMatchObject({ query: "launch", documents });
    workers[0].emit({ type: "progress", stage: "model" });
    expect(container.textContent).toContain("Preparing the search model");
    workers[0].emit({ type: "progress", stage: "index", completed: 1, total: 2 });
    expect(container.textContent).toContain("Indexing the conversation · 1 of 2 passages");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel preparation").click());
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Preparation cancelled. Text search is available.");
    expect(container.textContent).toContain("Text matches · 2");
  });

  it("stops the worker when Find closes during semantic preparation", () => {
    renderFind();
    const input = openFind();
    type(input, "launch");
    submit();
    expect(workers).toHaveLength(1);
    act(() => container.querySelector('[aria-label="Close Find"]').click());
    expect(container.querySelector("details").open).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("keeps text matches on semantic failure, retries, then returns the selected semantic result", () => {
    const onResult = vi.fn();
    renderFind({ onResult });
    const input = openFind();
    type(input, "launch");
    submit();
    act(() => workers[0].onerror({ message: "network unavailable" }));
    expect(container.querySelector('[role="alert"]').textContent).toContain("network unavailable");
    expect(container.textContent).toContain("Text matches · 2");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry meaning search").click());
    expect(workers).toHaveLength(2);
    const result = { key: "node:semantic", id: "node:semantic:0", kind: "node", nodeId: "semantic", title: "Meaning result", text: "A related passage" };
    workers[1].emit({ type: "results", results: [result], timings: [] });
    expect(container.textContent).toContain("Related passages · 1");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Meaning result")).click());
    expect(onResult).toHaveBeenCalledWith(result);
    expect(container.querySelector("details").open).toBe(false);
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
});
