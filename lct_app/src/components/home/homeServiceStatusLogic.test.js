import { describe, expect, it } from "vitest";

import { buildHomeStatusPresentation } from "./homeServiceStatusLogic";

/**
 * Test Intent
 * - Let the STT service's live `/health` payload decide whether inline diarization is ready.
 * - Prefer live FluidAudio evidence over stale catalog text that still says "planned".
 * - Expose a real unavailable/loading state instead of treating every Parakeet route as diarized.
 */

const catalogWithStaleFluidAudio = {
  active: {
    stt: "parakeet-mlx",
    stt_effective: "parakeet-mlx",
    diarization: "fluidaudio",
    diarization_effective: null,
  },
  stt: [
    {
      id: "parakeet-mlx",
      display_name: "Parakeet (MLX)",
      runtime: "m5-gpu-mlx",
      is_active: true,
      provides_diarization: true,
    },
  ],
  llm: [],
  diarization: [
    {
      id: "fluidaudio",
      display_name: "FluidAudio (CoreML / ANE)",
      runtime: "m5-ane",
      status: "planned",
      is_active: true,
    },
  ],
};

function presentationFor(diarization) {
  return buildHomeStatusPresentation({
    sttSettings: { provider: "parakeet" },
    sttProbe: {
      results: [
        {
          routeId: "configured_provider",
          label: "Parakeet",
          pathLabel: "Primary",
          healthy: true,
          url: "https://m5.example.test/health",
          health: {
            status: "healthy",
            engine: "fluidaudio-parakeet",
            model: "parakeet-tdt-0.6b-v3",
            diarization,
          },
        },
      ],
    },
    catalog: catalogWithStaleFluidAudio,
  });
}

describe("home speaker status", () => {
  it("shows live FluidAudio diarization as healthy even when catalog metadata is stale", () => {
    const result = presentationFor("ready");

    expect(result.diarLabel).toBe("Speakers: FluidAudio (ANE)");
    expect(result.diarSignal.state).toBe("healthy");
    expect(result.diarSignal.summary).toContain("running inside the live STT service");
    expect(JSON.stringify(result.diarSignal)).not.toContain("planned");
  });

  it("shows an explicit failure when the live STT service reports diarization unavailable", () => {
    const result = presentationFor("unavailable");

    expect(result.diarLabel).toBe("Speakers: FluidAudio");
    expect(result.diarSignal.state).toBe("unavailable");
    expect(result.diarSignal.summary).toContain("reported diarization as unavailable");
  });
});
