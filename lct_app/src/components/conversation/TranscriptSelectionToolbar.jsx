/**
 * TranscriptSelectionToolbar — floating toolbar anchored above the current
 * text selection in the transcript pane. Hosts a list of prayer-type slots;
 * each slot is one downstream action the user can take with the selection.
 *
 * MVP populates only the Recommend-consumption slot ("Show agenda with
 * [contact]"). Future slots documented in JSDoc per the prayer-type
 * vocabulary the user described:
 *
 *   1. Recommend-consumption  (active MVP)  — fetch this person's pending list
 *   2. Formalism              (placeholder) — trigger Layer 1→2 formalization
 *   3. Recommend-production   (placeholder) — earmark this for later
 *   4. Remind                 (placeholder) — defer with optional trigger
 *   5. SendTo                 (placeholder) — route this section to a contact
 *   6. Connect                (placeholder) — link two ideas / people
 *
 * Order reflects "active first, then reach-back/forward" per the choice
 * locked in earlier this session.
 *
 * Positioning: floating, anchored above the selection rect with viewport-
 * edge clamping. Backdrop click clears the selection (closes the toolbar).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Search } from "lucide-react";

const TOOLBAR_WIDTH = 320;
const TOOLBAR_OFFSET_TOP = 8; // gap between top of toolbar and bottom of selection
const VIEWPORT_PADDING = 12; // keep toolbar this far from viewport edges

export default function TranscriptSelectionToolbar({
  selection, // { text, rect } from useTextSelection — null hides the toolbar
  conversationContact, // optional: {contact_id, display_name} from picker
  knownContacts = [], // [{contact_id, display_name}, ...] for the dropdown
  onShowAgenda, // ({contactRef, selectedText}) => void
  onFetchPrayer, // ({selectedText}) => void
  onClose,
  loading = false,
  fetchLoading = false,
}) {
  const [pickedContactRef, setPickedContactRef] = useState("");

  // Detect contact names mentioned in the selected text, surface them as
  // suggested first option(s) in the dropdown. Per-session decision:
  // "Smart default — use conversation's contact, dropdown to switch, with
  //  selection-text name detection bumping that name to the top".
  const orderedContacts = useMemo(() => {
    if (!knownContacts.length) return [];
    const inText = new Set();
    if (selection?.text) {
      const lc = selection.text.toLowerCase();
      for (const c of knownContacts) {
        const name = (c.display_name || "").toLowerCase();
        if (name && lc.includes(name)) inText.add(c.contact_id);
      }
    }
    // Sort: mentioned-in-text → conversation contact → rest alphabetical
    return [...knownContacts].sort((a, b) => {
      const aInText = inText.has(a.contact_id);
      const bInText = inText.has(b.contact_id);
      if (aInText !== bInText) return aInText ? -1 : 1;
      const aIsCurrent = conversationContact?.contact_id === a.contact_id;
      const bIsCurrent = conversationContact?.contact_id === b.contact_id;
      if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
      return (a.display_name || "").localeCompare(b.display_name || "");
    });
  }, [knownContacts, selection, conversationContact]);

  // Default the picker to: first mentioned-in-text → conversation contact →
  // first known. Re-runs whenever the selection or contact list changes.
  useEffect(() => {
    if (!orderedContacts.length) {
      setPickedContactRef("");
      return;
    }
    setPickedContactRef(orderedContacts[0].contact_id);
  }, [orderedContacts]);

  // Anchor position above selection, clamped to viewport
  const position = useMemo(() => {
    if (!selection?.rect) return null;
    const rect = selection.rect;
    let top = rect.top - TOOLBAR_OFFSET_TOP; // toolbar's bottom edge sits this far above selection
    let left = rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2;
    // Clamp horizontal
    if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;
    if (left + TOOLBAR_WIDTH > window.innerWidth - VIEWPORT_PADDING) {
      left = window.innerWidth - TOOLBAR_WIDTH - VIEWPORT_PADDING;
    }
    // Use translate(-100% on Y) to anchor toolbar's bottom edge to `top`
    return {
      top: `${top}px`,
      left: `${left}px`,
      transform: "translateY(-100%)",
    };
  }, [selection]);

  if (!selection || !position) return null;

  const pickedContact = orderedContacts.find(
    (c) => c.contact_id === pickedContactRef,
  );
  const canTrigger = Boolean(pickedContactRef) && !loading;
  const canFetch = Boolean(selection.text?.trim()) && !fetchLoading;

  const handleShowAgenda = () => {
    if (!canTrigger) return;
    onShowAgenda?.({
      contactRef: pickedContactRef,
      selectedText: selection.text,
    });
  };

  const handleFetchPrayer = () => {
    if (!canFetch) return;
    onFetchPrayer?.({ selectedText: selection.text });
  };

  return (
    <div
      role="toolbar"
      aria-label="Selection prayer-type slots"
      className="fixed z-50 w-[320px] rounded-lg border border-gray-200 bg-white shadow-xl p-2 animate-slideIn"
      style={position}
    >
      {/* Active slot: Recommend-consumption */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span aria-hidden="true">🙏</span>
        <span className="text-sm text-gray-700 flex-1">Show agenda with</span>
        <select
          value={pickedContactRef}
          onChange={(e) => setPickedContactRef(e.target.value)}
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-800 max-w-[140px]"
          disabled={loading}
          aria-label="Contact to query"
        >
          {orderedContacts.length === 0 && <option value="">(no contacts)</option>}
          {orderedContacts.map((c) => (
            <option key={c.contact_id} value={c.contact_id}>
              {c.display_name || c.contact_id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleShowAgenda}
          disabled={!canTrigger}
          className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
            canTrigger
              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "bg-gray-100 text-gray-400 cursor-not-allowed"
          }`}
          title={
            pickedContact
              ? `Fetch pending discussions with ${pickedContact.display_name}`
              : "Pick a contact first"
          }
        >
          {loading ? "…" : "go"}
        </button>
      </div>

      {/* Active slot: Fetch prayer */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-t border-gray-100">
        <Search size={14} className="text-blue-500 shrink-0" aria-hidden="true" />
        <span className="text-sm text-gray-700 flex-1">Fetch memory</span>
        <button
          type="button"
          onClick={handleFetchPrayer}
          disabled={!canFetch}
          className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
            canFetch
              ? "bg-blue-100 text-blue-800 hover:bg-blue-200"
              : "bg-gray-100 text-gray-400 cursor-not-allowed"
          }`}
          title="Route this selection as a Fetch prayer"
        >
          {fetchLoading ? "..." : "go"}
        </button>
      </div>

      {/* Placeholder slots — documented as future prayer-type actions */}
      <div className="border-t border-gray-100 mt-1 pt-1 px-2 py-1 space-y-0.5">
        <PlaceholderSlot icon="✍️" label="Formalize this" />
        <PlaceholderSlot icon="📚" label="Earmark for later" />
        <PlaceholderSlot icon="⏰" label="Remind me about this" />
        <PlaceholderSlot icon="↗️" label="Send to…" />
      </div>

      {/* Selected text preview */}
      <div className="border-t border-gray-100 mt-1 pt-1.5 px-2 pb-1">
        <div className="text-[10px] tracking-wide uppercase text-gray-400 mb-0.5">
          selection
        </div>
        <div className="text-xs italic text-gray-600 line-clamp-2">
          &ldquo;{selection.text}&rdquo;
        </div>
      </div>

      {/* Close affordance */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-1.5 right-2 text-gray-300 hover:text-gray-500 text-sm leading-none"
        aria-label="Dismiss toolbar"
      >
        ×
      </button>
    </div>
  );
}

TranscriptSelectionToolbar.propTypes = {
  selection: PropTypes.shape({
    text: PropTypes.string.isRequired,
    rect: PropTypes.shape({
      top: PropTypes.number.isRequired,
      left: PropTypes.number.isRequired,
      width: PropTypes.number.isRequired,
      height: PropTypes.number.isRequired,
    }).isRequired,
  }),
  conversationContact: PropTypes.shape({
    contact_id: PropTypes.string,
    display_name: PropTypes.string,
  }),
  knownContacts: PropTypes.arrayOf(
    PropTypes.shape({
      contact_id: PropTypes.string.isRequired,
      display_name: PropTypes.string,
    }),
  ),
  onShowAgenda: PropTypes.func.isRequired,
  onFetchPrayer: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  fetchLoading: PropTypes.bool,
};


function PlaceholderSlot({ icon, label }) {
  return (
    <div
      className="flex items-center gap-2 px-1 py-1 text-xs text-gray-400 cursor-not-allowed"
      title="Not yet implemented — placeholder for future prayer-type slot"
    >
      <span aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="text-[10px] text-gray-300">soon</span>
    </div>
  );
}

PlaceholderSlot.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
};
