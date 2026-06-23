import { describe, it, expect } from "vitest";

import { edgeResultToWsMessage } from "./edgeTranscript";

describe("edgeResultToWsMessage", () => {
  it("maps a final result to a transcript_final message", () => {
    const msg = edgeResultToWsMessage({ utteranceId: 3, isFinal: true, text: " hi ", engine: "mlx-whisper" });
    expect(msg.type).toBe("transcript_final");
    expect(msg.text).toBe("hi");
    expect(msg.metadata).toMatchObject({ source: "web_client", transport: "edge_m5", utterance_id: 3, engine: "mlx-whisper" });
    expect(msg.timestamps).toEqual({});
    expect(msg.segments).toBeUndefined();
  });

  it("maps a partial result to a transcript_partial message", () => {
    expect(edgeResultToWsMessage({ isFinal: false, text: "x" }).type).toBe("transcript_partial");
  });

  it("attaches non-empty segments (with embeddings) but omits empty/missing ones", () => {
    const segments = [{ speaker: "SPEAKER_00", text: "hello", start: 0, end: 1, embedding: [0.1, 0.2] }];
    expect(edgeResultToWsMessage({ text: "hello", segments }).segments).toEqual(segments);
    expect(edgeResultToWsMessage({ text: "hi", segments: [] }).segments).toBeUndefined();
    expect(edgeResultToWsMessage({ text: "hi" }).segments).toBeUndefined();
  });

  it("stashes top-level speaker_embeddings in metadata when present", () => {
    const msg = edgeResultToWsMessage({ text: "hi", speakerEmbeddings: { SPEAKER_00: [0.1, 0.2] } });
    expect(msg.metadata.speaker_embeddings).toEqual({ SPEAKER_00: [0.1, 0.2] });
    expect(edgeResultToWsMessage({ text: "hi" }).metadata.speaker_embeddings).toBeUndefined();
  });

  it("defaults engine and trims text", () => {
    const msg = edgeResultToWsMessage({ text: "  spaced  " });
    expect(msg.text).toBe("spaced");
    expect(msg.metadata.engine).toBe("edge");
  });
});
