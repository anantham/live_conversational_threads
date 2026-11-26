// @vitest-environment jsdom
// Test intent (Codex review of PR #273): Settings' Back returns to the previous page when there is
// one, and goes Home when Settings was opened directly (no earlier entry to go back to).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SettingsLayout from "./SettingsLayout";

let root, host;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }

async function open(entries) {
  await act(async () => root.render(<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
    <Routes><Route path="/settings/*" element={<SettingsLayout />} /><Route path="*" element={null} /></Routes><Where />
  </MemoryRouter>));
  const back = [...host.querySelectorAll('nav[aria-label="Page"] button')].find((b) => b.textContent === "Back");
  await act(async () => back.click());
  return host.querySelector('[data-testid="where"]').textContent;
}

describe("Settings Back", () => {
  it("returns to the page the visitor came from", async () => {
    expect(await open(["/browse", "/settings/runtime"])).toBe("/browse");
  });
  it("goes Home when Settings was opened directly", async () => {
    expect(await open(["/settings/runtime"])).toBe("/");
  });
});
