import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Test Intent:
 * - The meeting viewer should subscribe to the meeting WebSocket route.
 * - A backend transcript_final frame should render immediately in the floating caption overlay.
 * - Speaker labels from Attendee metadata should be visible in minimized caption mode.
 * - Parallel CI load may delay the dynamic module import, without weakening any behavior assertion.
 */

const navigateMock = vi.fn();
const sendWsAuthMock = vi.fn();

vi.mock("react-router-dom", () => ({
  useParams: () => ({ conversationId: "meeting-123" }),
  useNavigate: () => navigateMock,
}));

vi.mock("../components/MinimalGraph", () => ({
  default: () => <div data-testid="minimal-graph" />,
}));

vi.mock("../services/apiClient", () => ({
  wsUrl: (path) => `ws://lct.test${path}`,
  sendWsAuth: (...args) => sendWsAuthMock(...args),
}));

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

describe("MeetingView", () => {
  let root;
  let container;
  let originalWebSocket;
  let originalActEnvironment;

  beforeEach(() => {
    vi.resetModules();
    navigateMock.mockReset();
    sendWsAuthMock.mockReset();
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    globalThis.WebSocket = originalWebSocket;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("renders speaker-attributed transcript frames in the caption overlay", async () => {
    const { default: MeetingView } = await import("./MeetingView");

    await act(async () => {
      root = createRoot(container);
      root.render(<MeetingView />);
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://lct.test/ws/meeting/meeting-123");

    await act(async () => {
      FakeWebSocket.instances[0].onopen?.();
    });
    expect(sendWsAuthMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "transcript_final",
          text: "the raw transcript should appear first",
          metadata: { speaker_name: "Aditya", speaker_uuid: "speaker-a" },
        }),
      });
    });

    expect(container.textContent).toContain("Meeting transcript");
    expect(container.textContent).toContain("Aditya:");
    expect(container.textContent).toContain("the raw transcript should appear first");
  }, 15_000);

  it("updates partial transcript frames in place", async () => {
    const { default: MeetingView } = await import("./MeetingView");

    await act(async () => {
      root = createRoot(container);
      root.render(<MeetingView />);
    });

    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "transcript_partial",
          text: "raw trans",
          metadata: { speaker_name: "Vatsal" },
        }),
      });
    });

    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: "transcript_partial",
          text: "raw transcript keeps changing",
          metadata: { speaker_name: "Vatsal" },
        }),
      });
    });

    expect(container.textContent).toContain("Vatsal:");
    expect(container.textContent).toContain("raw transcript keeps changing");
    expect(container.textContent).not.toContain("raw trans...");
  }, 15_000);
});
