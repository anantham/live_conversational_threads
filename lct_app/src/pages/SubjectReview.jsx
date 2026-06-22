import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, Plus, RotateCcw, X } from "lucide-react";

import { API_BASE_URL } from "../services/apiClient";

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

/**
 * Subject-side privacy review (ADR-039 P2b).
 *
 * A conversation SUBJECT opens an email-gated page and reviews the AI's
 * proposed redactions of THEIR OWN words. Per item they Confirm (the
 * redaction looks right), Hide more (also remove some currently-visible
 * words), or Reject (keep my original — don't redact). Their decisions are
 * relayed server-side back to IndrasNet, which merges + re-leak-verifies.
 *
 * This forks ShareConversation's Google-sign-in state machine. The only
 * content shown is the subject's own words + the proposed redaction of them
 * (both safe to show the subject — they were in the meeting), gated to
 * exactly subject_email. No graph, no audio, no producer free-text.
 *
 * Auth flow (identical to ShareConversation):
 *   1. GET /api/subject-review/<token>. 200 → render. 401 auth_required=google
 *      → show the GSI button; retry with Authorization: Bearer <id_token>.
 *   2. 403 = wrong Google account. 410 = revoked/expired.
 */

function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Window not available"));
      return;
    }
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${GSI_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("GSI script load failed")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("GSI script load failed"));
    document.head.appendChild(script);
  });
}

// --- word-level diff (no existing util in the codebase) -------------------

function tokenize(s) {
  // Keep whitespace tokens so the rendered text reads faithfully.
  return (s || "").split(/(\s+)/).filter((t) => t.length > 0);
}

/**
 * Diff the subject's original text against the proposed redaction at word
 * granularity. Returns segments {type: 'same'|'removed'|'added', text}:
 *   removed = the subject's words being hidden (struck through)
 *   added   = the redaction placeholder that replaces them
 *   same    = unchanged (and the only selectable text for "Hide more")
 */
function wordDiff(original, proposed) {
  const a = tokenize(original);
  const b = tokenize(proposed);
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs = [];
  const push = (type, text) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < n) {
    push("removed", a[i]);
    i++;
  }
  while (j < m) {
    push("added", b[j]);
    j++;
  }
  return segs;
}

const ACTIONS = {
  confirm: { label: "Looks right", icon: Check, hint: "Hide these words" },
  redact_more: { label: "Hide more", icon: Plus, hint: "Also hide some visible words" },
  reject: { label: "Keep my words", icon: X, hint: "Don't hide anything here" },
};

// --- the inline diff renderer ---------------------------------------------

function DiffView({ original, proposed, action, redactSpan }) {
  const segs = useMemo(() => wordDiff(original, proposed), [original, proposed]);
  // When the subject rejects, nothing is hidden → show their plain words.
  if (action === "reject") {
    return <span className="text-slate-800">{original}</span>;
  }
  return (
    <span className="leading-relaxed text-slate-800">
      {segs.map((seg, idx) => {
        if (seg.type === "same") {
          // The only selectable text — "Hide more" reads the selection from here.
          return <span key={idx}>{seg.text}</span>;
        }
        if (seg.type === "removed") {
          return (
            <del
              key={idx}
              className="select-none text-rose-500 decoration-rose-400/70"
              title="This will be hidden from others"
            >
              {seg.text}
            </del>
          );
        }
        // added = the redaction placeholder
        return (
          <span
            key={idx}
            className="mx-0.5 select-none rounded bg-slate-100 px-1 text-[11px] font-medium text-slate-400"
          >
            {seg.text.trim() || "·"}
          </span>
        );
      })}
      {action === "redact_more" && redactSpan ? (
        <span className="ml-1 select-none text-[11px] text-rose-500">
          (also hiding <del className="decoration-rose-400/70">{redactSpan}</del>)
        </span>
      ) : null}
    </span>
  );
}

// --- one review item -------------------------------------------------------

function ReviewItem({ item, decision, readOnly, onChoose, hideMoreActive, onStartHideMore, onCancelHideMore, onSpan }) {
  const containerRef = useRef(null);
  const [spanError, setSpanError] = useState("");

  const captureSelection = useCallback(() => {
    if (readOnly) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    const text = sel ? sel.toString().trim() : "";
    if (!text) return;
    // The contract: redact_span MUST be a substring of proposed_redaction
    // (the server re-validates). Only "same" text is selectable, so a clean
    // selection is always a substring; reject anything else with a hint.
    if (item.proposed_redaction.includes(text)) {
      setSpanError("");
      onSpan(item.position_in_doc, text);
      if (sel) sel.removeAllRanges();
    } else {
      setSpanError("Select a continuous part of your visible words.");
    }
  }, [readOnly, item.proposed_redaction, item.position_in_doc, onSpan]);

  const action = decision?.action || null;

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div
        ref={containerRef}
        onMouseUp={hideMoreActive ? captureSelection : undefined}
        onTouchEnd={hideMoreActive ? captureSelection : undefined}
        className="text-[15px]"
      >
        <DiffView
          original={item.original_text}
          proposed={item.proposed_redaction}
          action={action}
          redactSpan={decision?.redact_span}
        />
      </div>

      {hideMoreActive && (
        <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Highlight the words you also want hidden, then they&apos;ll be struck through.
          <button
            type="button"
            onClick={() => onCancelHideMore()}
            className="ml-2 underline hover:no-underline"
          >
            cancel
          </button>
          {spanError && <div className="mt-1 text-rose-600">{spanError}</div>}
        </div>
      )}

      {!readOnly && (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(ACTIONS).map(([key, meta]) => {
            const Icon = meta.icon;
            const active = action === key;
            const tone =
              key === "reject"
                ? active
                  ? "border-slate-400 bg-slate-800 text-white"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
                : active
                  ? "border-emerald-500 bg-emerald-600 text-white"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50";
            return (
              <button
                key={key}
                type="button"
                title={meta.hint}
                onClick={() => (key === "redact_more" ? onStartHideMore(item.position_in_doc) : onChoose(item.position_in_doc, key))}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${tone}`}
              >
                <Icon size={13} />
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default function SubjectReview() {
  const { token } = useParams();

  const [status, setStatus] = useState("loading"); // loading | needs_auth | ready | error | revoked
  const [errorDetail, setErrorDetail] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [bundle, setBundle] = useState(null); // { subject_name, items, status, viewer_email }
  const [decisions, setDecisions] = useState({}); // position_in_doc -> { action, redact_span? }
  const [hideMoreFor, setHideMoreFor] = useState(null);
  const [submitState, setSubmitState] = useState("idle"); // idle | submitting | relayed | failed
  const [submitDetail, setSubmitDetail] = useState("");

  const idTokenRef = useRef(null);
  const gsiButtonRef = useRef(null);

  const performFetch = useCallback(
    async (idToken) => {
      try {
        const headers = {};
        if (idToken) headers.Authorization = `Bearer ${idToken}`;
        const resp = await fetch(
          `${API_BASE_URL}/api/subject-review/${encodeURIComponent(token)}`,
          { headers },
        );

        if (resp.status === 401) {
          const body = await resp.json().catch(() => ({}));
          if (body?.auth_required === "google") {
            setGoogleClientId(body.google_client_id || "");
            setStatus("needs_auth");
            return;
          }
          setStatus("error");
          setErrorDetail(body?.detail || "Sign-in required.");
          return;
        }
        if (resp.status === 403) {
          const body = await resp.json().catch(() => ({}));
          setStatus("error");
          setErrorDetail(body?.detail || "This isn't the account this review was sent to.");
          return;
        }
        if (resp.status === 410) {
          const body = await resp.json().catch(() => ({}));
          setStatus("revoked");
          setErrorDetail(body?.detail || "This review link is no longer active.");
          return;
        }
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          setStatus("error");
          setErrorDetail(body?.detail || `Couldn't load the review (${resp.status}).`);
          return;
        }

        const payload = await resp.json();
        setBundle(payload);
        if (payload?.status && payload.status !== "pending") {
          // Already submitted earlier — show read-only with the terminal state.
          setSubmitState(payload.status === "relayed" ? "relayed" : "idle");
        }
        setStatus("ready");
      } catch (err) {
        setStatus("error");
        setErrorDetail(String(err?.message || err));
      }
    },
    [token],
  );

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorDetail("No review token in the link.");
      return;
    }
    void performFetch(null);
  }, [token, performFetch]);

  useEffect(() => {
    if (status !== "needs_auth" || !googleClientId) return;
    let cancelled = false;
    loadGsiScript()
      .then(() => {
        if (cancelled) return;
        const google = window.google;
        if (!google?.accounts?.id) {
          setStatus("error");
          setErrorDetail("Google sign-in library unavailable.");
          return;
        }
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp) => {
            if (!resp?.credential) return;
            idTokenRef.current = resp.credential;
            setStatus("loading");
            void performFetch(resp.credential);
          },
        });
        if (gsiButtonRef.current) {
          google.accounts.id.renderButton(gsiButtonRef.current, {
            type: "standard",
            theme: "outline",
            size: "large",
            text: "signin_with",
            shape: "rectangular",
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setErrorDetail(`Google sign-in failed to load: ${err?.message || err}`);
      });
    return () => {
      cancelled = true;
    };
  }, [status, googleClientId, performFetch]);

  const items = bundle?.items || [];
  const alreadySubmitted = Boolean(bundle?.status && bundle.status !== "pending");
  const readOnly = alreadySubmitted || submitState === "relayed";

  const decidedCount = items.filter((it) => decisions[it.position_in_doc]?.action).length;
  const allDecided = items.length > 0 && decidedCount === items.length;

  const choose = useCallback((position, action) => {
    setHideMoreFor((cur) => (cur === position ? null : cur));
    setDecisions((d) => ({ ...d, [position]: { action } }));
  }, []);

  const startHideMore = useCallback((position) => {
    setHideMoreFor(position);
  }, []);

  const cancelHideMore = useCallback(() => setHideMoreFor(null), []);

  const setSpan = useCallback((position, span) => {
    setDecisions((d) => ({ ...d, [position]: { action: "redact_more", redact_span: span } }));
    setHideMoreFor(null);
  }, []);

  const submit = useCallback(async () => {
    if (!allDecided || readOnly) return;
    setSubmitState("submitting");
    setSubmitDetail("");
    const payload = {
      decisions: items.map((it) => {
        const d = decisions[it.position_in_doc];
        const out = { position_in_doc: it.position_in_doc, action: d.action };
        if (d.action === "redact_more" && d.redact_span) out.redact_span = d.redact_span;
        return out;
      }),
    };
    try {
      const resp = await fetch(
        `${API_BASE_URL}/api/subject-review/${encodeURIComponent(token)}/decisions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idTokenRef.current || ""}`,
          },
          body: JSON.stringify(payload),
        },
      );
      if (resp.ok) {
        setSubmitState("relayed");
        return;
      }
      if (resp.status === 409) {
        // Single-use: already submitted (possibly a retry that landed). Treat as done.
        setSubmitState("relayed");
        return;
      }
      const body = await resp.json().catch(() => ({}));
      setSubmitState("failed");
      setSubmitDetail(
        body?.detail || `Couldn't send your review (${resp.status}). Please try again.`,
      );
    } catch (err) {
      setSubmitState("failed");
      setSubmitDetail(String(err?.message || err));
    }
  }, [allDecided, readOnly, items, decisions, token]);

  // ---- screens ----

  if (status === "loading") {
    return (
      <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#fafafa]">
        <div className="text-sm text-slate-500">Loading your review…</div>
      </div>
    );
  }

  if (status === "needs_auth") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-xl font-medium text-slate-800">Review your words before they&apos;re shared</div>
        <p className="mb-6 max-w-md text-sm text-slate-600">
          Sign in with Google so we can confirm this review is for you. We only see
          your email — nothing else.
        </p>
        <div ref={gsiButtonRef} />
        {!googleClientId && (
          <p className="mt-4 text-xs text-red-600">
            This server isn&apos;t configured for Google sign-in. Ask the sender to set
            <code className="ml-1">GOOGLE_OAUTH_CLIENT_ID</code>.
          </p>
        )}
      </div>
    );
  }

  if (status === "revoked") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-lg font-medium text-slate-800">This review link is no longer active</div>
        <p className="max-w-md text-sm text-slate-500">{errorDetail}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-lg font-medium text-slate-800">Can&apos;t open this review</div>
        <p className="max-w-md text-sm text-slate-500">{errorDetail}</p>
      </div>
    );
  }

  // status === "ready"
  if (submitState === "relayed") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <Check className="text-emerald-600" size={24} />
        </div>
        <div className="mb-2 text-lg font-medium text-slate-800">Thanks — your review was sent</div>
        <p className="max-w-md text-sm text-slate-500">
          Your choices were sent back for the final privacy check. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-screen bg-[#fafafa] font-sans">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur">
        <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-400">
          Privacy review · just for you
        </p>
        <h1 className="text-base font-semibold text-slate-800">
          Review your words{bundle?.subject_name ? `, ${bundle.subject_name}` : ""}
        </h1>
        {bundle?.viewer_email && (
          <p className="mt-0.5 text-[11px] text-slate-500">signed in as {bundle.viewer_email}</p>
        )}
      </header>

      <main className="mx-auto max-w-2xl px-4 pb-32 pt-4">
        <p className="mb-4 text-sm leading-relaxed text-slate-600">
          Before this conversation is shared, here&apos;s how your own words would be
          hidden. <span className="text-rose-500 line-through decoration-rose-400/70">Struck-through</span>{" "}
          text will be hidden from others. For each one, choose to keep the redaction
          (<span className="font-medium">Looks right</span>), hide a bit more, or keep
          your original words.
        </p>

        {alreadySubmitted && (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            You&apos;ve already submitted this review — it&apos;s shown below read-only.
          </div>
        )}

        {items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            There&apos;s nothing to review here.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((it) => (
              <ReviewItem
                key={it.position_in_doc}
                item={it}
                decision={decisions[it.position_in_doc]}
                readOnly={readOnly}
                onChoose={choose}
                hideMoreActive={hideMoreFor === it.position_in_doc}
                onStartHideMore={startHideMore}
                onCancelHideMore={cancelHideMore}
                onSpan={setSpan}
              />
            ))}
          </ul>
        )}
      </main>

      {!readOnly && items.length > 0 && (
        <footer className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {decidedCount} of {items.length} reviewed
            </span>
            <div className="flex items-center gap-3">
              {submitState === "failed" && (
                <span className="hidden text-xs text-rose-600 sm:inline">{submitDetail}</span>
              )}
              <button
                type="button"
                disabled={!allDecided || submitState === "submitting"}
                onClick={submit}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {submitState === "submitting" ? (
                  "Sending…"
                ) : submitState === "failed" ? (
                  <>
                    <RotateCcw size={14} /> Retry
                  </>
                ) : (
                  "Submit review"
                )}
              </button>
            </div>
          </div>
          {submitState === "failed" && (
            <p className="mx-auto mt-1 max-w-2xl text-center text-xs text-rose-600 sm:hidden">{submitDetail}</p>
          )}
        </footer>
      )}
    </div>
  );
}
