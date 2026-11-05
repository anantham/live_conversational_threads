export function recordAuthUiTiming(stage, durationMs, outcome, retryCount) {
  try {
    const key = "lct.sites_auth_ui_timing.v1";
    const stored = JSON.parse(window.localStorage.getItem(key) || "[]");
    const previous = Array.isArray(stored) ? stored.filter((sample) =>
      ["config", "challenge", "loading", "google", "verifying", "signout"].includes(sample?.stage) &&
      ["complete", "inactive", "error", "timeout", "cancelled"].includes(sample?.outcome) &&
      Number.isFinite(sample?.durationMs) && sample.durationMs >= 0 &&
      Number.isInteger(sample?.retryCount) && sample.retryCount >= 0,
    ).map((sample) => ({ stage: sample.stage, durationMs: sample.durationMs,
      outcome: sample.outcome, retryCount: sample.retryCount })) : [];
    window.localStorage.setItem(key, JSON.stringify([...previous,
      { stage, durationMs: Math.max(0, Math.round(durationMs)), outcome, retryCount },
    ].slice(-8)));
  } catch {
    // Timing history is optional; public browsing and sign-in never depend on storage.
  }
}

export function requestWithin(path, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => { controller.abort(); done(new DOMException("Cancelled", "AbortError")); };
    const timer = window.setTimeout(() => {
      controller.abort();
      done(new Error("This step timed out. Please try again."));
    }, timeoutMs);
    if (parentSignal?.aborted) { onAbort(); return; }
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      return fetch(path, { credentials: "same-origin", cache: "no-store", ...options, signal: controller.signal });
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "The request could not finish. Please try again.");
        return body;
      }).then((body) => done(null, body), (error) => done(error));
  });
}
