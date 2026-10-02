import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useViewerHistory } from "./useViewerHistory";

// Intent: replay public browser navigation, preserve edits, replace camera-only
// movement, truncate a forward branch, and isolate a newly opened artifact.
let container, root;
function Harness() {
  const rootRef = useRef(null);
  const [session, setSession] = useState(0);
  const [name, setName] = useState("Original");
  const [state, setState] = useState({ node: null, viewMode: "graph", graphRevision: 0, graphNavigation: null });
  const history = useViewerHistory({ enabled: true, sessionKey: session, state, onRestore: setState, rootRef });
  return <div ref={rootRef}>
    <output>{`${state.node || "start"}:${state.viewMode}:${name}:${state.graphNavigation?.viewport?.x ?? 0}`}</output>
    <button onClick={() => setState((s) => ({ ...s, node: "A" }))}>A</button>
    <button onClick={() => setState((s) => ({ ...s, node: "B", viewMode: "discussion" }))}>B</button>
    <button onClick={() => setState((s) => ({ ...s, node: "C" }))}>C</button>
    <button onClick={() => setState((s) => ({ ...s, graphNavigation: { viewport: { x: 125, y: 0, zoom: 1 } } }))}>Pan</button>
    <button onClick={() => setName("Reviewed name")}>Rename</button>
    <button disabled={!history.canBack} onClick={history.goBack}>Back</button>
    <button disabled={!history.canForward} onClick={history.goForward}>Forward</button>
    <button onClick={() => { setSession((s) => s + 1); setState({ node: null, viewMode: "graph", graphRevision: 0, graphNavigation: null }); }}>Another</button>
    <div data-viewer-scroll="discussion" />
  </div>;
}
const button = (label) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const click = async (label) => { await act(async () => { button(label).click(); await flush(); }); await act(flush); };
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({ idx: 0 }, "", "/view");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
  await act(flush);
});
afterEach(() => { act(() => root.unmount()); container.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });

it("restores node/view/camera with browser Back and Forward without reverting a name edit", async () => {
  expect(button("Back").disabled).toBe(true);
  await click("A"); await click("Pan"); await click("B"); await click("Rename");
  const marker = window.history.state;
  expect(Object.keys(marker).sort()).toEqual(["idx", "lctExploration"]);
  expect(JSON.stringify(marker)).not.toContain("Reviewed name");
  await act(async () => { window.history.back(); await flush(); }); await act(flush);
  expect(container.querySelector("output").textContent).toBe("A:graph:Reviewed name:125");
  expect(button("Forward").disabled).toBe(false);
  await click("Forward");
  expect(container.querySelector("output").textContent).toBe("B:discussion:Reviewed name:125");
  await click("Back"); await click("Back");
  expect(container.querySelector("output").textContent).toBe("start:graph:Reviewed name:0");
  expect(button("Back").disabled).toBe(true);
});

it("discards the forward exploration when a different jump follows Back", async () => {
  await click("A"); await click("B"); await click("Back"); await click("C");
  expect(button("Forward").disabled).toBe(true);
  await click("Back");
  expect(container.querySelector("output").textContent).toBe("A:graph:Original:0");
});

it("starts a separate history for another artifact and refuses stale pointers", async () => {
  await click("A"); const old = window.history.state;
  await click("Another");
  expect(button("Back").disabled).toBe(true);
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: old })); await flush(); });
  expect(container.querySelector("output").textContent).toBe("start:graph:Original:0");
});
