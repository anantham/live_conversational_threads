// @vitest-environment jsdom
// Test intent (Codex review of PR #273, two rounds): Settings' Back returns to the previous page
// when there is one, and goes Home when Settings was the first page in the tab, including after
// /settings redirects to /settings/runtime with replace. Uses the real browser router, because
// its history position is what tells the two cases apart.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SettingsLayout from "./SettingsLayout";

let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function openAt(path) {
  window.history.replaceState(null, "", path); // a fresh first entry for this tab
  await act(async () => root.render(<BrowserRouter><Routes>
    <Route path="/settings" element={<SettingsLayout />}>
      <Route index element={<Navigate replace to="runtime" />} />
      <Route path="runtime" element={<p>Providers</p>} />
    </Route>
    <Route path="*" element={<Link to="/settings">Open settings</Link>} />
  </Routes></BrowserRouter>));
}
const click = (el) => act(async () => el.click());
const back = () => [...host.querySelectorAll('nav[aria-label="Page"] button')].find((b) => b.textContent === "Back");

describe("Settings Back", () => {
  it("returns to the page the visitor came from", async () => {
    await openAt("/browse");
    await click(host.querySelector('a[href="/settings"]'));
    expect(window.location.pathname).toBe("/settings/runtime");
    await click(back());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20))); // popstate is async
    expect(window.location.pathname).toBe("/browse");
  });
  it("goes Home when Settings was opened directly, even after its redirect", async () => {
    await openAt("/settings");
    expect(window.location.pathname).toBe("/settings/runtime");
    await click(back());
    expect(window.location.pathname).toBe("/");
  });
});
