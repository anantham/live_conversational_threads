import { useEffect, useState } from "react";
import {
  fetchKnownContacts,
  fetchUserIdentity,
} from "../../services/participantsApi";
import { apiFetch } from "../../services/apiClient";

/**
 * Settings card for picking which IndrasNet contact is "me".
 * Pre-populates the participant picker so the user doesn't have to
 * check themselves on every new recording.
 */
export default function UserIdentityCard() {
  const [contacts, setContacts] = useState([]);
  const [selfId, setSelfId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // {kind: 'ok'|'error', text}

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchKnownContacts(), fetchUserIdentity()])
      .then(([contactsList, identity]) => {
        if (cancelled) return;
        setContacts(contactsList);
        setSelfId(identity?.self_contact_id || "");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const r = await apiFetch("/api/user-identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ self_contact_id: selfId || null }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail || `Save failed (${r.status})`);
      }
      const body = await r.json();
      setSelfId(body?.self_contact_id || "");
      setStatus({ kind: "ok", text: "Saved" });
    } catch (e) {
      setStatus({ kind: "error", text: e?.message || "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const selectedContact = contacts.find((c) => c.contact_id === selfId);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <header className="mb-4">
        <h3 className="text-base font-semibold text-gray-800">
          User identity
        </h3>
        <p className="mt-1 text-sm text-gray-600">
          Which IndrasNet contact is you? The participant picker pre-checks
          this on every new recording so you don't have to.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-gray-500">Loading contacts…</p>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">
              You are…
            </span>
            <select
              value={selfId}
              onChange={(e) => setSelfId(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              <option value="">— Not set —</option>
              {contacts.map((c) => (
                <option key={c.contact_id} value={c.contact_id}>
                  {c.display_name}
                </option>
              ))}
            </select>
            {selectedContact && selectedContact.external_llm_ok === false ? (
              <p className="mt-1 text-xs text-amber-700">
                This contact is marked privacy-restricted; your voice clip
                will stay local even when you record with cloud STT.
              </p>
            ) : null}
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {status ? (
              <span
                className={`text-xs ${
                  status.kind === "ok"
                    ? "text-green-700"
                    : "text-amber-700"
                }`}
              >
                {status.text}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
