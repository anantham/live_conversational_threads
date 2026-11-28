// Test intent: see useLocalConversationAudio.js. A stub stands in for the browser store; no audio plays.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playableLocalAudio, useLocalConversationAudio } from "./useLocalConversationAudio";

const part = (number, size = 4) => ({ number, blob: new Blob([new Uint8Array(size)], { type: "audio/webm" }), complete: true });
const saved = (segments, complete = true) => ({ audio: { ...segments.at(-1), segments, complete } });

describe("which saved audio can be played against the map", () => {
  it("accepts one complete part and nothing else", () => {
    expect(playableLocalAudio(saved([part(1)]))).toBeInstanceOf(Blob);
    expect(playableLocalAudio(saved([part(1), part(2)]))).toBeNull(); // a paused recording: offsets unknown
    expect(playableLocalAudio(saved([part(1)], false))).toBeNull();
    expect(playableLocalAudio(saved([part(1, 0)]))).toBeNull();
    expect(playableLocalAudio(null)).toBeNull();
  });
});

describe("useLocalConversationAudio", () => {
  let root, host, created, revoked, latest;
  // eslint-disable-next-line react/prop-types
  function Probe({ id, enabled = true, read }) { latest = useLocalConversationAudio(id, enabled, read); return null; }
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true; created = []; revoked = []; latest = undefined;
    const NativeURL = globalThis.URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = () => { const url = `blob:audio-${created.length + 1}`; created.push(url); return url; };
      static revokeObjectURL = (url) => revoked.push(url);
    });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("reads the store once per conversation, so re-rendering after a map edit keeps the same audio", async () => {
    const read = vi.fn(async () => saved([part(1)]));
    await act(async () => root.render(<Probe id="c1" read={read} />)); await flush();
    expect(latest).toBe("blob:audio-1");
    for (let i = 0; i < 3; i += 1) { await act(async () => root.render(<Probe id="c1" read={read} />)); await flush(); }
    expect(read).toHaveBeenCalledTimes(1);
    expect(latest).toBe("blob:audio-1");
    expect(revoked).toEqual([]);
  });

  it("releases the old audio when the conversation changes or the viewer closes", async () => {
    const read = vi.fn(async () => saved([part(1)]));
    await act(async () => root.render(<Probe id="c1" read={read} />)); await flush();
    await act(async () => root.render(<Probe id="c2" read={read} />)); await flush();
    expect(revoked).toEqual(["blob:audio-1"]);
    expect(latest).toBe("blob:audio-2");
    await act(async () => root.unmount()); root = createRoot(host);
    expect(revoked).toEqual(["blob:audio-1", "blob:audio-2"]);
  });

  it("does not read the store at all when disabled, as for a public copy", async () => {
    const read = vi.fn(async () => saved([part(1)]));
    await act(async () => root.render(<Probe id="c1" enabled={false} read={read} />)); await flush();
    expect(read).not.toHaveBeenCalled();
    expect(latest).toBe("");
  });

  it("offers nothing for a recording stored in several parts, or when the store fails", async () => {
    await act(async () => root.render(<Probe id="c1" read={async () => saved([part(1), part(2)])} />)); await flush();
    expect(latest).toBe("");
    await act(async () => root.render(<Probe id="c2" read={async () => { throw new Error("blocked"); }} />)); await flush();
    expect(latest).toBe("");
    expect(created).toEqual([]);
  });

  it('never returns the previous conversation\'s URL in the render after a switch', async () => {
    const seen = [];
    // eslint-disable-next-line react/prop-types
    function Recorder({ id, read }) { const url = useLocalConversationAudio(id, true, read); seen.push([id, url]); return null; }
    const read = vi.fn(async () => saved([part(1)]));
    await act(async () => root.render(<Recorder id="c1" read={read} />)); await flush();
    await act(async () => root.render(<Recorder id="c2" read={read} />));
    expect(seen.filter(([id, url]) => id === "c2" && url === "blob:audio-1")).toEqual([]);
  });
});
