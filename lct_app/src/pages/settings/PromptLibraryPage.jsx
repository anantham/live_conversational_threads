import PromptEditorCard from "../../components/settings/PromptEditorCard";
import PromptHistoryModal from "../../components/settings/PromptHistoryModal";
import usePromptLibraryState from "../../components/settings/usePromptLibraryState";
import useUnsavedChangesGuard from "../../components/settings/useUnsavedChangesGuard";

const UNSAVED_PROMPT_MESSAGE = "Discard unsaved prompt changes and leave the prompt library?";

export default function PromptLibraryPage() {
  const {
    currentConfig,
    editedConfig,
    error,
    handleCancel,
    handleEdit,
    handleReload,
    handleRestore,
    handleSave,
    hasUnsavedChanges,
    history,
    isEditing,
    loading,
    loadHistory,
    prompts,
    saveComment,
    saving,
    selectPrompt,
    selectedPrompt,
    setEditedConfig,
    setError,
    setSaveComment,
    setShowHistory,
    showHistory,
    validationErrors,
  } = usePromptLibraryState();

  useUnsavedChangesGuard(hasUnsavedChanges, UNSAVED_PROMPT_MESSAGE);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center rounded-lg bg-white shadow">
        <div className="text-center">
          <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600"></div>
          <p className="text-gray-600">Loading prompt library...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">Prompt Library</h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-600">
            Prompt authoring is separate from runtime routing so you do not have to scan operational
            config while editing templates.
          </p>
        </div>
        <button
          onClick={handleReload}
          className="rounded-lg bg-gray-600 px-4 py-2 text-white transition hover:bg-gray-700"
          type="button"
        >
          Reload from File
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-red-700">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-2 text-sm text-red-600 underline"
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <aside className="lg:col-span-1">
          <div className="rounded-lg bg-white p-4 shadow">
            <h3 className="mb-3 text-lg font-bold text-gray-800">Prompts ({prompts.length})</h3>
            <div className="space-y-2">
              {prompts.map((promptName) => (
                <button
                  key={promptName}
                  onClick={() => selectPrompt(promptName)}
                  className={`w-full rounded px-3 py-2 text-left transition ${
                    selectedPrompt === promptName
                      ? "bg-blue-100 font-medium text-blue-800"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                  type="button"
                >
                  {promptName.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="lg:col-span-3">
          <PromptEditorCard
            currentConfig={currentConfig}
            editedConfig={editedConfig}
            isEditing={isEditing}
            onCancel={handleCancel}
            onEdit={handleEdit}
            onHistory={loadHistory}
            onSave={handleSave}
            saveComment={saveComment}
            saving={saving}
            selectedPrompt={selectedPrompt}
            setEditedConfig={setEditedConfig}
            setSaveComment={setSaveComment}
            validationErrors={validationErrors}
          />
        </div>
      </div>

      {showHistory ? (
        <PromptHistoryModal
          history={history}
          onClose={() => setShowHistory(false)}
          onRestore={handleRestore}
          promptName={selectedPrompt}
        />
      ) : null}
    </div>
  );
}
