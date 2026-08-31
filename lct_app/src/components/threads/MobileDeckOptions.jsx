import PropTypes from "prop-types";
import { Download, FilePlus2, House, LibraryBig, RefreshCw } from "lucide-react";

import MobileDeckSheet from "./MobileDeckSheet";
import { mobileDeckLevelInfo } from "./mobileConversationDeckModel";

function ActionRow({ icon: Icon, label, onClick, secondary }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-slate-800">{label}</span>
        {secondary && <span className="mt-0.5 block text-xs leading-5 text-slate-500">{secondary}</span>}
      </span>
    </button>
  );
}

ActionRow.propTypes = {
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  secondary: PropTypes.string,
};

export default function MobileDeckOptions({
  bundle,
  counts,
  libraryStatus,
  live = false,
  onAnnounceLayer,
  onClose,
  onDownloadTranscript,
  onOpenAnother,
  onOpenLibrary,
  onRefreshFromDrive,
  open,
}) {
  return (
    <MobileDeckSheet open={open} onClose={onClose} title="Conversation options">
      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500">Structure</p>
        <div className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {[5, 4, 3, 2, 1].map((level) => {
            const info = mobileDeckLevelInfo(level);
            const count = counts[level] || 0;
            return (
              <button
                key={level}
                type="button"
                onClick={() => onAnnounceLayer(level)}
                className="flex min-h-11 w-full items-center justify-between px-3 text-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
              >
                <span className="capitalize text-slate-700">{info.plural}</span>
                <span className={`tabular-nums ${count ? "text-slate-500" : "text-slate-400"}`}>
                  {count || "none"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-3">
        {live ? (
          <ActionRow
            icon={House}
            label="Leave live view"
            secondary="Return home; the meeting keeps recording"
            onClick={() => {
              onClose();
              onOpenLibrary();
            }}
          />
        ) : (
          <>
            <ActionRow
              icon={Download}
              label="Download transcript"
              secondary="Save the artifact’s transcript as text"
              onClick={() => {
                onClose();
                onDownloadTranscript();
              }}
            />
            <ActionRow
              icon={LibraryBig}
              label="Library"
              secondary="Return to conversations saved in this browser"
              onClick={() => {
                onClose();
                onOpenLibrary();
              }}
            />
            {onRefreshFromDrive && (
              <ActionRow
                icon={RefreshCw}
                label="Refresh from Drive"
                secondary="Fetch the newest permitted copy"
                onClick={onRefreshFromDrive}
              />
            )}
            <ActionRow
              icon={FilePlus2}
              label="Open another file"
              secondary="Choose a different .threads artifact"
              onClick={onOpenAnother}
            />
          </>
        )}
      </div>

      {(libraryStatus || bundle.coverage) && (
        <div className="mt-4 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
          {libraryStatus?.message && <p>{libraryStatus.message}</p>}
          {bundle.coverage?.total_turns != null && (
            <p>
              Source linkage: {bundle.coverage.covered_turns || 0} of {bundle.coverage.total_turns} turns
            </p>
          )}
        </div>
      )}
    </MobileDeckSheet>
  );
}

MobileDeckOptions.propTypes = {
  bundle: PropTypes.shape({ coverage: PropTypes.object }).isRequired,
  counts: PropTypes.objectOf(PropTypes.number).isRequired,
  libraryStatus: PropTypes.shape({ message: PropTypes.string, state: PropTypes.string }),
  live: PropTypes.bool,
  onAnnounceLayer: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onDownloadTranscript: PropTypes.func.isRequired,
  onOpenAnother: PropTypes.func.isRequired,
  onOpenLibrary: PropTypes.func.isRequired,
  onRefreshFromDrive: PropTypes.func,
  open: PropTypes.bool.isRequired,
};
