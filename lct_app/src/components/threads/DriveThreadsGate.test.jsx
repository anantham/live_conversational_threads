import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DriveThreadsGate from "./DriveThreadsGate";

/*
 * Test intent:
 * - A Drive link is a clear account-selection gate, not a file-upload instruction.
 * - One explicit click authorizes, downloads, and hands the validated artifact to the viewer.
 * - Failed authorization remains recoverable with an account retry.
 * - Failed Google-library preparation remains recoverable without a page reload.
 * - Missing deployment configuration is named before the user clicks anything.
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
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function clickButton() {
  act(() => {
    container.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DriveThreadsGate", () => {
  it("opens the shared artifact after one Google authorization gesture", async () => {
    const bundle = { format: "lct.threads", format_version: 1, graph_data: [] };
    const authorize = vi.fn(async () => "temporary-token");
    const fetchArtifact = vi.fn(async () => bundle);
    const onArtifact = vi.fn();
    await act(async () => {
      root.render(
        <DriveThreadsGate
          fileId="abc_DEF-1234"
          clientId="web-client-id"
          prepareAuthorization={async () => {}}
          authorize={authorize}
          fetchArtifact={fetchArtifact}
          onArtifact={onArtifact}
        />,
      );
    });

    expect(container.textContent).toContain("Open this conversation in Threads");
    expect(container.textContent).not.toContain("upload");
    clickButton();
    await act(async () => {});
    await act(async () => {});

    expect(authorize).toHaveBeenCalledWith("web-client-id");
    expect(fetchArtifact).toHaveBeenCalledWith("abc_DEF-1234", "temporary-token");
    expect(onArtifact).toHaveBeenCalledWith(bundle, {
      sourceName: "Google Drive",
    });
  });

  it("explains an account mismatch and offers a retry", async () => {
    await act(async () => {
      root.render(
        <DriveThreadsGate
          fileId="abc_DEF-1234"
          clientId="web-client-id"
          prepareAuthorization={async () => {}}
          authorize={async () => "temporary-token"}
          fetchArtifact={async () => {
            throw new Error("This Google account cannot download the conversation map.");
          }}
          onArtifact={() => {}}
        />,
      );
    });
    clickButton();
    await act(async () => {});
    await act(async () => {});

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "This Google account cannot download",
    );
    expect(container.querySelector("button")?.textContent).toContain("Try another Google account");
  });

  it("retries Google-library preparation after a transient load failure", async () => {
    const prepareAuthorization = vi
      .fn()
      .mockRejectedValueOnce(new Error("Google authorization timed out."))
      .mockResolvedValueOnce(undefined);

    await act(async () => {
      root.render(
        <DriveThreadsGate
          fileId="abc_DEF-1234"
          clientId="web-client-id"
          prepareAuthorization={prepareAuthorization}
          onArtifact={() => {}}
        />,
      );
    });

    const retryButton = container.querySelector("button");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Google authorization timed out",
    );
    expect(retryButton?.textContent).toContain("Retry Google sign-in");
    expect(retryButton?.disabled).toBe(false);

    clickButton();
    await act(async () => {});

    expect(prepareAuthorization).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("button")?.textContent).toContain("Continue with Google");
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("names missing deployment configuration without opening a popup", async () => {
    await act(async () => {
      root.render(
        <DriveThreadsGate
          fileId="abc_DEF-1234"
          clientId=""
          onArtifact={() => {}}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "not configured on this deployment",
    );
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
