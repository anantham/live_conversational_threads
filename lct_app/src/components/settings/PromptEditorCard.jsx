import PropTypes from "prop-types";

export default function PromptEditorCard({
  currentConfig,
  editedConfig,
  isEditing,
  onCancel,
  onEdit,
  onHistory,
  onSave,
  saveComment,
  saving,
  selectedPrompt,
  setEditedConfig,
  setSaveComment,
  validationErrors,
}) {
  if (!currentConfig) {
    return (
      <div className="rounded-lg bg-white p-6 text-center text-gray-500 shadow">
        Select a prompt to view details
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-bold text-gray-800">{selectedPrompt}</h3>
          <p className="mt-1 text-sm text-gray-600">{currentConfig.description}</p>
        </div>
        <div className="flex gap-2">
          {!isEditing ? (
            <>
              <button
                onClick={onHistory}
                className="rounded bg-gray-600 px-4 py-2 text-white transition hover:bg-gray-700"
                type="button"
              >
                View History
              </button>
              <button
                onClick={onEdit}
                className="rounded bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
                type="button"
              >
                Edit Prompt
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onCancel}
                className="rounded bg-gray-300 px-4 py-2 text-gray-700 transition hover:bg-gray-400"
                disabled={saving}
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={onSave}
                className="rounded bg-green-600 px-4 py-2 text-white transition hover:bg-green-700"
                disabled={saving}
                type="button"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </>
          )}
        </div>
      </div>

      {validationErrors.length > 0 ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3">
          <p className="mb-2 font-medium text-red-800">Validation Errors:</p>
          <ul className="space-y-1 text-sm text-red-700">
            {validationErrors.map((err, index) => (
              <li key={`${err}-${index}`}>• {err}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {isEditing ? (
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Change Comment (optional)
          </label>
          <input
            type="text"
            value={saveComment}
            onChange={(event) => setSaveComment(event.target.value)}
            placeholder="Describe your changes..."
            className="w-full rounded border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
          />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Model</label>
          {isEditing ? (
            <select
              value={editedConfig.model}
              onChange={(event) => setEditedConfig({ ...editedConfig, model: event.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            >
              <option value="gpt-4">GPT-4</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
            </select>
          ) : (
            <p className="font-medium text-gray-800">{currentConfig.model}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Temperature</label>
          {isEditing ? (
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={editedConfig.temperature}
              onChange={(event) =>
                setEditedConfig({
                  ...editedConfig,
                  temperature: Number.parseFloat(event.target.value),
                })
              }
              className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
          ) : (
            <p className="font-medium text-gray-800">{currentConfig.temperature}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Max Tokens</label>
          {isEditing ? (
            <input
              type="number"
              value={editedConfig.max_tokens}
              onChange={(event) =>
                setEditedConfig({
                  ...editedConfig,
                  max_tokens: Number.parseInt(event.target.value, 10),
                })
              }
              className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
            />
          ) : (
            <p className="font-medium text-gray-800">{currentConfig.max_tokens}</p>
          )}
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">Prompt Template</label>
        {isEditing ? (
          <textarea
            value={editedConfig.template}
            onChange={(event) =>
              setEditedConfig({
                ...editedConfig,
                template: event.target.value,
              })
            }
            className="w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-blue-500"
            rows={20}
          />
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-gray-300 bg-gray-50 p-4 text-sm font-mono">
            {currentConfig.template}
          </pre>
        )}
        <p className="mt-1 text-xs text-gray-500">
          Use {"$variable"} or {"${{variable}}"} syntax for variable substitution
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
        {isEditing ? (
          <input
            type="text"
            value={editedConfig.description}
            onChange={(event) =>
              setEditedConfig({
                ...editedConfig,
                description: event.target.value,
              })
            }
            className="w-full rounded border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <p className="text-gray-700">{currentConfig.description}</p>
        )}
      </div>
    </div>
  );
}

PromptEditorCard.propTypes = {
  currentConfig: PropTypes.object,
  editedConfig: PropTypes.object,
  isEditing: PropTypes.bool.isRequired,
  onCancel: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onHistory: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  saveComment: PropTypes.string.isRequired,
  saving: PropTypes.bool.isRequired,
  selectedPrompt: PropTypes.string,
  setEditedConfig: PropTypes.func.isRequired,
  setSaveComment: PropTypes.func.isRequired,
  validationErrors: PropTypes.arrayOf(PropTypes.string).isRequired,
};
