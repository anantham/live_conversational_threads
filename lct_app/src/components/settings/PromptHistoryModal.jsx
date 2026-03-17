import PropTypes from "prop-types";

export default function PromptHistoryModal({ history, onClose, onRestore, promptName }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-6">
          <h3 className="text-xl font-bold text-gray-800">Version History: {promptName}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700" type="button">
            ✕
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6">
          {history.length > 0 ? (
            <div className="space-y-4">
              {history.map((version, index) => (
                <div
                  key={`${version.timestamp}-${index}`}
                  className="rounded-lg border border-gray-300 p-4 hover:bg-gray-50"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-600">
                          {version.change_type}
                        </span>
                        <span className="text-xs text-gray-500">{version.timestamp}</span>
                        <span className="text-xs text-gray-500">by {version.user_id}</span>
                      </div>
                      {version.comment ? (
                        <p className="mb-2 text-sm text-gray-700">{version.comment}</p>
                      ) : null}
                      <details className="text-sm">
                        <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                          View Configuration
                        </summary>
                        <pre className="mt-2 overflow-x-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs">
                          {JSON.stringify(version.prompt_config, null, 2)}
                        </pre>
                      </details>
                    </div>
                    <button
                      onClick={() => onRestore(version.timestamp)}
                      className="ml-4 rounded bg-blue-600 px-3 py-1 text-sm text-white transition hover:bg-blue-700"
                      type="button"
                    >
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-500">No version history available</p>
          )}
        </div>
      </div>
    </div>
  );
}

PromptHistoryModal.propTypes = {
  history: PropTypes.arrayOf(PropTypes.object).isRequired,
  onClose: PropTypes.func.isRequired,
  onRestore: PropTypes.func.isRequired,
  promptName: PropTypes.string,
};
