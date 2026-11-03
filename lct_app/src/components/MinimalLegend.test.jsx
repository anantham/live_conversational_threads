import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MinimalLegend from "./MinimalLegend";
import { fetchConversationSpeakers } from "../services/speakerNamingApi";

vi.mock("../services/speakerNamingApi", () => ({
  fetchConversationSpeakers: vi.fn(), updateConversationSpeakerName: vi.fn(),
}));
vi.mock("../services/artifactSettingsApi", () => ({ rerouteConversationArtifacts: vi.fn() }));

// Test intent: public aliases update an already-open legend immediately, without
// presenting a second naming form or contacting the private conversation API.
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

it("keeps public speaker labels current and naming in Source", () => {
  const render = (names) => act(() => root.render(<MinimalLegend
    speakerColorMap={{ SPEAKER_00: "#7dd3fc" }} speakerDisplayNames={names}
  />));
  render(new Map());
  act(() => host.querySelector('button[aria-label="Show legend: speakers and edge colors"]').click());
  expect(host.textContent).toContain("SPEAKER_00");
  render(new Map([["SPEAKER_00", "Example speaker"]]));
  expect(host.textContent).toContain("Example speaker");
  render(new Map([["SPEAKER_00", "Reviewed speaker"]]));
  expect(host.textContent).toContain("Reviewed speaker");
  expect(host.textContent).not.toContain("Example speaker");
  expect(host.querySelector("input")).toBeNull();
  expect(fetchConversationSpeakers).not.toHaveBeenCalled();
});

it("offers inline controls and a keyboard-closeable key without losing aliases", () => {
  const name = "Synthetic speaker with a deliberately long display name";
  act(() => root.render(<MinimalLegend inline
    speakerColorMap={{ SPEAKER_00: "#7dd3fc" }}
    speakerDisplayNames={new Map([["SPEAKER_00", name]])}
    controls={<button type="button">Synthetic reading control</button>}
  />));
  const trigger = host.querySelector('button[aria-label="Show legend: speakers and edge colors"]');
  expect(host.textContent).toContain("Synthetic reading control");
  act(() => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('section[aria-label="Speaker colors and edge key"]').textContent).toContain(name);
  const close = host.querySelector('button[aria-label="Close legend"]');
  close.focus();
  act(() => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("section")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger.click());
  expect(host.querySelector("section").textContent).toContain(name);
  expect(fetchConversationSpeakers).not.toHaveBeenCalled();
});
