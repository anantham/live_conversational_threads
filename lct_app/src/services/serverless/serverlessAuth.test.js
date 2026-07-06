import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startTrial,
  isTrialActive,
  trialMsRemaining,
  serverlessAuthHeaders,
  trialAvailable,
  TRIAL_DURATION,
} from "./serverlessAuth";

describe("serverlessAuth", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a real key produces the BYOK header", () => {
    expect(serverlessAuthHeaders("sk-abc")).toEqual({ "x-lct-byok-key": "sk-abc" });
  });

  it("no key and no trial returns null so the caller prompts for a key", () => {
    expect(serverlessAuthHeaders("")).toBeNull();
    expect(serverlessAuthHeaders("   ")).toBeNull();
  });

  it("an active trial with no key sends the trial flag, not a key", () => {
    startTrial();
    expect(isTrialActive()).toBe(true);
    expect(serverlessAuthHeaders("")).toEqual({ "x-lct-trial": "1" });
  });

  it("a real key wins over an active trial", () => {
    startTrial();
    expect(serverlessAuthHeaders("sk-abc")).toEqual({ "x-lct-byok-key": "sk-abc" });
  });

  it("the trial expires after its window", () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    startTrial();
    expect(isTrialActive()).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(t0 + TRIAL_DURATION + 1);
    expect(isTrialActive()).toBe(false);
    expect(serverlessAuthHeaders("")).toBeNull();
  });

  it("startTrial is idempotent and does not reset the clock", () => {
    const t0 = 2_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    startTrial();

    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    startTrial(); // must NOT restart the window
    expect(trialMsRemaining()).toBeLessThanOrEqual(TRIAL_DURATION - 60_000 + 5);
  });

  it("trialAvailable only before a trial starts and only without a key", () => {
    expect(trialAvailable("")).toBe(true);
    expect(trialAvailable("sk-abc")).toBe(false);
    startTrial();
    expect(trialAvailable("")).toBe(false);
  });
});
