import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import {
  fetchKnownContacts,
  fetchUserIdentity,
  fetchConversationParticipants,
  putConversationParticipants,
  searchKnownContacts,
} from "../../services/participantsApi";

const DEFAULT_INITIAL_VISIBLE = 5;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_CHARS = 2;

/**
 * Non-blocking modal that overlays a fresh recording on New Conversation.
 * The mic keeps capturing underneath — confirming or dismissing doesn't
 * stop transcription. Selection is persisted to Conversation.participants
 * so the STT priming step sees it on the next refinement call.
 *
 * Re-openable mid-session for late-joiner additions; existing selections
 * are pre-checked when re-entered.
 */
export default function ParticipantPickerModal({
  open,
  conversationId,
  onClose,
  onSaved,
}) {
  const [contacts, setContacts] = useState([]);
  const [selfContactId, setSelfContactId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Ad-hoc "guest" participants — names typed for people not in the
  // IndrasNet contact list. Plain strings; persisted with contact_id=null.
  const [adHocNames, setAdHocNames] = useState([]);
  const [searchText, setSearchText] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [searchResults, setSearchResults] = useState([]); // server-side matches for long tail
  const [searching, setSearching] = useState(false);
  const searchSeqRef = useRef(0); // guard against out-of-order responses

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      fetchKnownContacts(),
      fetchUserIdentity(),
      fetchConversationParticipants(conversationId),
    ])
      .then(([contactsList, identity, existing]) => {
        if (cancelled) return;
        setContacts(contactsList);
        setSelfContactId(identity?.self_contact_id || null);

        // Seed selection: existing participants from a prior open in this
        // session take priority. Otherwise pre-check self if known.
        const seed = new Set();
        const adHoc = [];
        if (existing.length > 0) {
          for (const p of existing) {
            if (p?.contact_id) seed.add(p.contact_id);
            else if (p?.display_name) adHoc.push(p.display_name);
          }
        } else if (identity?.self_contact_id) {
          seed.add(identity.self_contact_id);
        }
        setSelectedIds(seed);
        setAdHocNames(adHoc);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load contacts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  // Server-side search for the long tail (names beyond the top-50 default).
  // Debounced so we don't spam IndrasNet per keystroke. We still do the
  // client-side filter immediately for snappy feedback on the top-N.
  useEffect(() => {
    if (!open) return undefined;
    const q = searchText.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }
    const mySeq = ++searchSeqRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchKnownContacts(q).then((rows) => {
        // Discard if a newer keystroke superseded us — prevents flicker
        // when fast input arrives faster than IndrasNet responds.
        if (mySeq !== searchSeqRef.current) return;
        setSearchResults(rows);
        setSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, searchText]);

  const filteredContacts = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return contacts;
    // Client-side: instant hit from the top-N already in memory.
    const localMatches = contacts.filter((c) =>
      (c.display_name || "").toLowerCase().includes(query),
    );
    if (!searchResults.length) return localMatches;
    // Merge with server-side results, deduping by contact_id. Local-first
    // so the user sees consistent ordering (their recent contacts at top).
    const seen = new Set(localMatches.map((c) => c.contact_id));
    const extras = searchResults.filter((c) => !seen.has(c.contact_id));
    return [...localMatches, ...extras];
  }, [contacts, searchText, searchResults]);

  // Pin self to the top so the user notices the pre-selection (and can
  // uncheck it for trick conversations where they're just recording
  // someone else).
  const orderedContacts = useMemo(() => {
    if (!selfContactId) return filteredContacts;
    const self = filteredContacts.find((c) => c.contact_id === selfContactId);
    if (!self) return filteredContacts;
    const rest = filteredContacts.filter(
      (c) => c.contact_id !== selfContactId,
    );
    return [self, ...rest];
  }, [filteredContacts, selfContactId]);

  const visibleContacts = useMemo(() => {
    if (showAll || searchText.trim()) return orderedContacts;
    return orderedContacts.slice(0, DEFAULT_INITIAL_VISIBLE);
  }, [orderedContacts, showAll, searchText]);

  const hiddenCount = Math.max(
    0,
    orderedContacts.length - visibleContacts.length,
  );

  const totalSelected = selectedIds.size + adHocNames.length;

  const toggleContact = useCallback((contactId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) {
        next.delete(contactId);
      } else {
        next.add(contactId);
      }
      return next;
    });
  }, []);

  // Add the typed name as an ad-hoc guest (someone not in contacts).
  const addAdHocGuest = useCallback(() => {
    const name = searchText.trim();
    if (!name) return;
    setAdHocNames((prev) =>
      prev.some((n) => n.toLowerCase() === name.toLowerCase())
        ? prev
        : [...prev, name],
    );
    setSearchText("");
  }, [searchText]);

  const removeAdHocGuest = useCallback((name) => {
    setAdHocNames((prev) => prev.filter((n) => n !== name));
  }, []);

  const handleConfirm = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const byId = new Map(contacts.map((c) => [c.contact_id, c]));
      const participants = [];
      for (const cid of selectedIds) {
        const c = byId.get(cid);
        if (!c) continue;
        participants.push({
          contact_id: c.contact_id,
          display_name: c.display_name,
          external_llm_ok: Boolean(c.external_llm_ok),
          source: "picker",
        });
      }
      // Ad-hoc guests: name-only, no contact_id. external_llm_ok stays null
      // so the STT priming passes the name but never grabs a clip by a
      // name collision (an ad-hoc guest has no voice library entry).
      for (const name of adHocNames) {
        participants.push({
          contact_id: null,
          display_name: name,
          external_llm_ok: null,
          source: "manual",
        });
      }
      const saved = await putConversationParticipants({
        conversationId,
        participants,
      });
      onSaved?.(saved);
      onClose?.();
    } catch (e) {
      setError(e?.message || "Failed to save participants");
    } finally {
      setSaving(false);
    }
  }, [contacts, selectedIds, adHocNames, conversationId, onSaved, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Choose who is in this conversation"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Who&apos;s in this conversation?
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Tap to add. Recording continues in the background.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-5 pt-3">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search contacts or add a name…"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
          />
          {searching ? (
            <p className="mt-1 text-[11px] text-gray-400">
              Searching all contacts…
            </p>
          ) : null}
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-2 pb-1 pt-2">
          {adHocNames.length > 0 ? (
            <ul className="mb-0.5 space-y-0.5">
              {adHocNames.map((name) => (
                <li key={`adhoc-${name}`}>
                  <button
                    type="button"
                    onClick={() => removeAdHocGuest(name)}
                    className="flex w-full items-center gap-3 rounded-lg bg-blue-50 px-3 py-2 text-left transition hover:bg-blue-100"
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-blue-600 bg-blue-600 text-white"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                    <span className="flex flex-1 items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{name}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                        guest
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500">
              Loading contacts…
            </p>
          ) : visibleContacts.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-500">
              {searchText
                ? "No matches."
                : "No contacts available."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visibleContacts.map((c) => {
                const checked = selectedIds.has(c.contact_id);
                const isSelf = c.contact_id === selfContactId;
                return (
                  <li key={c.contact_id}>
                    <button
                      type="button"
                      onClick={() => toggleContact(c.contact_id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
                        checked
                          ? "bg-blue-50 hover:bg-blue-100"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-gray-300 bg-white"
                        }`}
                        aria-hidden="true"
                      >
                        {checked ? "✓" : ""}
                      </span>
                      <span className="flex flex-1 items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">
                          {c.display_name}
                        </span>
                        {isSelf ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                            you
                          </span>
                        ) : null}
                        {c.confirmed ? (
                          <span
                            className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700"
                            title="Confirmed — a human-reviewed real person, not an auto-formed guess (ADR-058)"
                          >
                            confirmed
                          </span>
                        ) : null}
                        {c.external_llm_ok === false ? (
                          <span
                            className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
                            title="Voice clip will stay local (privacy tier)"
                          >
                            local-only
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-1 w-full rounded-lg px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50"
            >
              Show {hiddenCount} more
            </button>
          ) : null}

          {/* Add someone not in the IndrasNet contact list — type a name,
              add them as an ad-hoc guest (name-only, no contact record). */}
          {searchText.trim() ? (
            <button
              type="button"
              onClick={addAdHocGuest}
              className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50"
            >
              <span className="text-base font-semibold leading-none">+</span>
              <span>
                Add <span className="font-medium">{searchText.trim()}</span> as a guest
              </span>
            </button>
          ) : null}
        </div>

        {error ? (
          <p className="border-t border-amber-100 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            {error}
          </p>
        ) : null}

        <footer className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving
              ? "Saving…"
              : `Confirm${totalSelected > 0 ? ` (${totalSelected})` : ""}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

ParticipantPickerModal.propTypes = {
  open: PropTypes.bool.isRequired,
  conversationId: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
};
