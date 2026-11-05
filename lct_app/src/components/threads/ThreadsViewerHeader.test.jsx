import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ThreadsViewerHeader from "./ThreadsViewerHeader";

/* Test intent:
 * - The title remains visible while the overview starts closed.
 * - Clicking the conversation title reveals its overview in either view.
 * - Save errors remain visible without opening artifact details.
 */
let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

const bundle = {
  conversation_title: "Synthetic conversation",
  executive_summary: "Synthetic overview text.",
};

describe("ThreadsViewerHeader", () => {
  it("shows the title with the overview closed by default", () => {
    act(() => root.render(<ThreadsViewerHeader bundle={bundle} />));
    expect(container.querySelector("h1")?.textContent).toBe("Synthetic conversation");
    expect(container.textContent).not.toContain("Synthetic overview text.");
    expect(container.textContent).not.toContain("100%");
    expect(container.textContent).not.toContain("read-only");
  });

  it("uses the conversation title to request its overview while preserving the title when drilling", () => {
    const toggle = vi.fn();
    act(() => root.render(<ThreadsViewerHeader bundle={bundle} focusNode={{ title: "Focused idea", summary: "Focused summary." }} overviewOpen onToggleOverview={toggle} />));
    expect(container.querySelector("h1")?.textContent).toBe("Synthetic conversation");
    expect(container.textContent).toContain("Synthetic overview text.");
    expect(container.querySelector("button").getAttribute("aria-expanded")).toBe("true");
    act(() => container.querySelector("button").click());
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("keeps a save error visible", () => {
    act(() => root.render(<ThreadsViewerHeader bundle={bundle} libraryStatus={{ state: "error", message: "Save failed. Retry." }} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed. Retry.");
  });
});
