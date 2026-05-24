import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Copy, Trash2, Plus } from "lucide-react";

import { API_BASE_URL } from "../../services/apiClient";

/**
 * Modal for managing public share links of a conversation.
 *
 * Operator-facing UI:
 *   - List active shares (token, allowlist, view count, last viewer)
 *   - Mint a new share with optional email allowlist (comma-separated)
 *   - Copy share URL to clipboard
 *   - Revoke an existing share
 *
 * All API calls use the same auth path the rest of the operator UI uses
 * (whatever apiFetch wraps). Recipients hit /share/<token> separately.
 */
export default function ShareManagerModal({ conversationId, onClose }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newAllowedEmails, setNewAllowedEmails] = useState("");
  const [copiedToken, setCopiedToken] = useState("");

  const loadShares = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(
        `${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/shares`,
        { credentials: "include" },
      );
      if (!resp.ok) {
        throw new Error(`Load shares failed (${resp.status})`);
      }
      const data = await resp.json();
      setShares(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError("");
    try {
      const emails = newAllowedEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const body = { allowed_emails: emails.length > 0 ? emails : null };
      const resp = await fetch(
        `${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}/share`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.detail || `Create failed (${resp.status})`);
      }
      setNewAllowedEmails("");
      await loadShares();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setCreating(false);
    }
  }, [conversationId, newAllowedEmails, loadShares]);

  const handleRevoke = useCallback(
    async (token) => {
      if (!window.confirm("Revoke this share? Anyone holding the URL will lose access.")) return;
      try {
        const resp = await fetch(
          `${API_BASE_URL}/api/share/${encodeURIComponent(token)}`,
          { method: "DELETE" },
        );
        if (!resp.ok) {
          throw new Error(`Revoke failed (${resp.status})`);
        }
        await loadShares();
      } catch (e) {
        setError(String(e?.message || e));
      }
    },
    [loadShares],
  );

  const handleCopy = useCallback((token) => {
    const url = `${window.location.origin}/share/${token}`;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url);
      setCopiedToken(token);
      window.setTimeout(() => setCopiedToken(""), 1500);
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-800">Share this conversation</h2>
          <button
            onClick={onClose}
            className="text-xl leading-none text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {/* New share form */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
              New share link
            </h3>
            <label className="block text-xs text-slate-600 mb-1">
              Allowed emails (comma-separated). Leave empty for public-by-link.
            </label>
            <textarea
              value={newAllowedEmails}
              onChange={(e) => setNewAllowedEmails(e.target.value)}
              rows={2}
              placeholder="alice@gmail.com, bob@example.com"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] text-slate-500">
                Restricted shares require recipients to sign in with Google.
              </p>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
              >
                <Plus size={12} />
                {creating ? "Creating…" : "Create link"}
              </button>
            </div>
          </section>

          {/* Active shares list */}
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
              Active shares
            </h3>
            {loading ? (
              <p className="text-sm text-slate-500 italic">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-slate-500 italic">No active shares yet.</p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => {
                  const url = `${window.location.origin}/share/${s.token}`;
                  return (
                    <li
                      key={s.token}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <code className="truncate text-[11px] text-slate-700">{url}</code>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleCopy(s.token)}
                            className="rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                            title="Copy URL"
                          >
                            <Copy size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRevoke(s.token)}
                            className="rounded p-1.5 text-red-500 hover:bg-red-100 hover:text-red-700"
                            title="Revoke share"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {copiedToken === s.token && (
                        <p className="mt-1 text-[10px] text-emerald-600">Copied to clipboard</p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                        <span>
                          {s.allowed_emails?.length
                            ? `restricted to ${s.allowed_emails.length} email${s.allowed_emails.length === 1 ? "" : "s"}`
                            : "public-by-link"}
                        </span>
                        <span>{s.view_count} views</span>
                        {s.last_viewed_at && (
                          <span>last viewed {new Date(s.last_viewed_at).toLocaleString()}</span>
                        )}
                        {s.last_viewed_by && <span>by {s.last_viewed_by}</span>}
                      </div>
                      {s.allowed_emails?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.allowed_emails.map((email) => (
                            <span
                              key={email}
                              className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-600 border border-slate-200"
                            >
                              {email}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {error && (
            <p className="text-xs text-red-600 rounded bg-red-50 px-3 py-2 border border-red-200">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

ShareManagerModal.propTypes = {
  conversationId: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
};
