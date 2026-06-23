import { describe, it, expect } from "vitest";

import { readEdgeConfig } from "./edgeConfig";

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

describe("readEdgeConfig", () => {
  it("defaults to disabled with the default M5 URL", () => {
    const cfg = readEdgeConfig("", memStorage());
    expect(cfg.enabled).toBe(false);
    expect(cfg.diarize).toBe(false);
    expect(cfg.includeEmbeddings).toBe(false);
    expect(cfg.url).toContain("adityas-macbook-pro.tail4741ad.ts.net:5443");
  });

  it("?edge=1 enables and persists to storage", () => {
    const store = memStorage();
    expect(readEdgeConfig("?edge=1", store).enabled).toBe(true);
    expect(store.getItem("lct_stt_edge")).toBe("1");
    // sticks on a later load with no query param
    expect(readEdgeConfig("", store).enabled).toBe(true);
  });

  it("?edge=0 disables and persists (kill switch)", () => {
    const store = memStorage({ lct_stt_edge: "1" });
    expect(readEdgeConfig("?edge=0", store).enabled).toBe(false);
    expect(readEdgeConfig("", store).enabled).toBe(false);
  });

  it("toggles diarize/embeddings flags independently", () => {
    const cfg = readEdgeConfig("?edge=1&edge_diarize=1", memStorage());
    expect(cfg.diarize).toBe(true);
    expect(cfg.includeEmbeddings).toBe(false);
  });

  it("?edge_url overrides the endpoint", () => {
    expect(readEdgeConfig("?edge_url=https://m5.example/v1", memStorage()).url).toBe("https://m5.example/v1");
  });

  it("survives unavailable storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => readEdgeConfig("?edge=1", throwing)).not.toThrow();
    expect(readEdgeConfig("?edge=1", throwing).enabled).toBe(true); // query value still honored
  });
});
