import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PublicDriveThreadsGate from "./PublicDriveThreadsGate";

// Test intent: public links auto-open without OAuth; failure is explicit and
// retryable; incidental parent rerenders never restart the download.
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });
it("loads automatically once despite changing callback identity", async () => {
  const artifact = { format: "lct.threads" };
  const loadArtifact = vi.fn(async () => artifact);
  const received = [];
  for (let i = 0; i < 2; i++) {
    await act(async () => root.render(<PublicDriveThreadsGate fileId="abc_DEF-1234" loadArtifact={loadArtifact} onArtifact={(data) => received.push(data)} />));
  }
  expect(loadArtifact).toHaveBeenCalledTimes(1);
  expect(received).toEqual([artifact]);
  expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
});
it("offers retry and an explicit private link when Drive denies anonymous access", async () => {
  const loadArtifact = vi.fn().mockRejectedValueOnce(new Error("This file is not public.")).mockResolvedValueOnce({ format: "lct.threads" });
  const onArtifact = vi.fn();
  await act(async () => root.render(<PublicDriveThreadsGate fileId="abc_DEF-1234" loadArtifact={loadArtifact} onArtifact={onArtifact} />));
  expect(container.querySelector('[role="alert"]').textContent).toContain("not public");
  expect(container.querySelector("a").getAttribute("href")).toBe("/view?driveFile=abc_DEF-1234");
  await act(async () => container.querySelector("button").click());
  expect(onArtifact).toHaveBeenCalledTimes(1);
});
it("cancels a download when the opener unmounts", async () => {
  let signal;
  await act(async () => root.render(<PublicDriveThreadsGate fileId="abc_DEF-1234" loadArtifact={(_id, options) => { signal = options.signal; return new Promise(() => {}); }} onArtifact={() => {}} />));
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});
