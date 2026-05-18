/**
 * ConsumptionPrayerDrawer — right-side slide-in panel showing pending
 * discussions for the selected contact.
 *
 * Rendered conditionally by NewConversation when the user opens the chip.
 * Pure presentation — receives items + contact + close handler. State lives
 * in the parent so it can be triggered from multiple sources (chip click,
 * selection toolbar, future auto-detection WS event).
 *
 * Item shape (matches IndrasNet response):
 *   { text, prayer_id, added_at, source }
 *
 * Empty state surfaces the contact's note_path so the user can manually
 * append items in Obsidian if they want — closes the loop on the
 * "Obsidian is the source of truth" design commitment.
 */

import PropTypes from "prop-types";

export default function ConsumptionPrayerDrawer({
  open,
  contact,
  items = [],
  status = "ok",
  notePath = "",
  selectedText = "",
  triggeredAt = "",
  onClose,
}) {
  if (!open) return null;

  const displayName = contact?.display_name || "this person";

  return (
    <>
      {/* Backdrop: subtle, dismissible */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/10 backdrop-blur-[1px] cursor-default"
      />

      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-label={`Pending discussions with ${displayName}`}
        className="fixed top-0 right-0 z-50 h-full w-[360px] max-w-[90vw] bg-white shadow-2xl border-l border-gray-200 flex flex-col animate-slideIn"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <div className="text-[10px] tracking-wide uppercase text-gray-500">
              pending discussions
            </div>
            <h2
              className="text-lg font-semibold text-gray-900 truncate"
              title={displayName}
            >
              {displayName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {/* Triggered-from line */}
        {selectedText && (
          <div className="px-5 py-2 border-b border-gray-100 bg-gray-50/50">
            <div className="text-[10px] tracking-wide uppercase text-gray-500 mb-0.5">
              triggered from
            </div>
            <div className="text-xs italic text-gray-700 line-clamp-2">
              &ldquo;{selectedText}&rdquo;
            </div>
          </div>
        )}

        {/* Items list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {status === "no_note_path" ? (
            <EmptyState
              title="No note configured"
              message={`${displayName} has no obsidian_note_path. Set one in the IndrasNet contacts UI and the agenda will start populating.`}
            />
          ) : status === "note_missing" ? (
            <EmptyState
              title="Note doesn't exist yet"
              message={
                notePath
                  ? `Waiting for the first confirmed Remind/Connect prayer to create it.`
                  : "Note hasn't been created yet."
              }
              notePath={notePath}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing pending"
              message={`No items under '## Pending discussions' in ${displayName}'s note.`}
              notePath={notePath}
            />
          ) : (
            <ul className="space-y-2.5">
              {items.map((item, idx) => (
                <PendingItemCard key={item.prayer_id ?? `freeform-${idx}`} item={item} />
              ))}
            </ul>
          )}
        </div>

        {/* Footer: note path + trigger meta */}
        <footer className="px-5 py-2.5 border-t border-gray-200 bg-gray-50/50 text-[10px] text-gray-500">
          {notePath && (
            <div className="truncate font-mono mb-0.5" title={notePath}>
              {notePath}
            </div>
          )}
          {triggeredAt && (
            <div>triggered manually at {formatTime(triggeredAt)}</div>
          )}
        </footer>
      </aside>
    </>
  );
}

ConsumptionPrayerDrawer.propTypes = {
  open: PropTypes.bool,
  contact: PropTypes.shape({
    contact_id: PropTypes.string,
    display_name: PropTypes.string,
  }),
  items: PropTypes.arrayOf(
    PropTypes.shape({
      text: PropTypes.string.isRequired,
      prayer_id: PropTypes.number,
      added_at: PropTypes.string,
      source: PropTypes.string,
    }),
  ),
  status: PropTypes.string,
  notePath: PropTypes.string,
  selectedText: PropTypes.string,
  triggeredAt: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};


function PendingItemCard({ item }) {
  const when = item.added_at ? relativeTime(item.added_at) : null;
  return (
    <li className="rounded-lg border border-gray-200 px-3 py-2.5 hover:bg-gray-50 transition-colors">
      <div className="text-sm text-gray-900 leading-relaxed">{item.text}</div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-gray-500 tracking-wide">
        {item.prayer_id != null && (
          <span className="font-mono" title={`prayer_instances.instance_id = ${item.prayer_id}`}>
            #{item.prayer_id}
          </span>
        )}
        {when && (
          <>
            {item.prayer_id != null && <span aria-hidden="true">·</span>}
            <span title={item.added_at}>{when}</span>
          </>
        )}
        {item.source && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono truncate" title={item.source}>
              {sourceLabel(item.source)}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

PendingItemCard.propTypes = {
  item: PropTypes.shape({
    text: PropTypes.string.isRequired,
    prayer_id: PropTypes.number,
    added_at: PropTypes.string,
    source: PropTypes.string,
  }).isRequired,
};


function EmptyState({ title, message, notePath }) {
  return (
    <div className="text-center py-12 px-2">
      <div className="text-sm font-medium text-gray-700 mb-1">{title}</div>
      <div className="text-xs text-gray-500 leading-relaxed">{message}</div>
      {notePath && (
        <div className="mt-3 text-[10px] text-gray-400 font-mono break-all">
          {notePath}
        </div>
      )}
    </div>
  );
}

EmptyState.propTypes = {
  title: PropTypes.string.isRequired,
  message: PropTypes.string.isRequired,
  notePath: PropTypes.string,
};


// --- Helpers ---

function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatTime(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function sourceLabel(source) {
  if (!source) return "";
  if (source.startsWith("pendant_")) return "pendant";
  if (source.startsWith("telegram_")) return "telegram";
  if (source.startsWith("meet_")) return "meet";
  return source.length > 18 ? `${source.slice(0, 18)}…` : source;
}
