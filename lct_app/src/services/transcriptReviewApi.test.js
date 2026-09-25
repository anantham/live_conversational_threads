// Public transport intent: private transcript reads and CAS writes reuse the configured app bearer token.
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
it("uses the existing app bearer token for read and correction requests", async () => {
  vi.stubEnv("VITE_AUTH_TOKEN", "synthetic-app-token");
  vi.stubEnv("VITE_BACKEND_API_URL", "");
  vi.resetModules();
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({utterances: []}), {status: 200, headers: {"Content-Type": "application/json"}}));
  vi.stubGlobal("fetch", fetch);
  const { fetchTranscriptReview, correctTranscriptText } = await import("./transcriptReviewApi");
  await fetchTranscriptReview("synthetic-conversation");
  await correctTranscriptText("synthetic-conversation", {id: "synthetic-row", text: "Before"}, "After");
  expect(fetch.mock.calls.map(([,options]) => options.headers.Authorization)).toEqual(["Bearer synthetic-app-token", "Bearer synthetic-app-token"]);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({expected_text: "Before", text: "After"});
});
