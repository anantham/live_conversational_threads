import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getPrompt,
  getPromptHistory,
  listPrompts,
  reloadPrompts,
  restorePromptVersion,
  updatePrompt,
  validatePrompt,
} from "../../services/promptsApi";

const DISMISS_CHANGES_MESSAGE = "Discard unsaved prompt changes?";

const clonePromptConfig = (config) => (config ? { ...config } : null);

export default function usePromptLibraryState() {
  const [prompts, setPrompts] = useState([]);
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const [promptConfig, setPromptConfig] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedConfig, setEditedConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [saveComment, setSaveComment] = useState("");

  const hasConfigChanges = useMemo(() => {
    if (!isEditing || !editedConfig || !promptConfig) {
      return false;
    }
    return JSON.stringify(editedConfig) !== JSON.stringify(promptConfig);
  }, [editedConfig, isEditing, promptConfig]);

  const hasUnsavedChanges = Boolean(
    isEditing && (hasConfigChanges || String(saveComment || "").trim().length > 0),
  );

  const confirmDiscardChanges = useCallback((message = DISMISS_CHANGES_MESSAGE) => {
    if (!hasUnsavedChanges) {
      return true;
    }
    return window.confirm(message);
  }, [hasUnsavedChanges]);

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await listPrompts();
      const promptNames = Array.isArray(data?.prompts) ? data.prompts : [];
      setPrompts(promptNames);
      setSelectedPrompt((current) => {
        if (current && promptNames.includes(current)) {
          return current;
        }
        return promptNames[0] || null;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPromptDetails = useCallback(async () => {
    if (!selectedPrompt) {
      setPromptConfig(null);
      return;
    }

    try {
      const config = await getPrompt(selectedPrompt);
      setPromptConfig(config);
      setEditedConfig(null);
      setIsEditing(false);
      setValidationErrors([]);
      setSaveComment("");
    } catch (err) {
      setError(err.message);
    }
  }, [selectedPrompt]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  useEffect(() => {
    if (!selectedPrompt) {
      return;
    }
    void loadPromptDetails();
  }, [loadPromptDetails, selectedPrompt]);

  const loadHistory = useCallback(async () => {
    if (!selectedPrompt) return;

    try {
      const historyData = await getPromptHistory(selectedPrompt, 20);
      setHistory(historyData.history || []);
      setShowHistory(true);
    } catch (err) {
      setError(err.message);
    }
  }, [selectedPrompt]);

  const selectPrompt = useCallback((promptName) => {
    if (!promptName || promptName === selectedPrompt) {
      return;
    }
    if (!confirmDiscardChanges()) {
      return;
    }
    setSelectedPrompt(promptName);
  }, [confirmDiscardChanges, selectedPrompt]);

  const handleEdit = useCallback(() => {
    setEditedConfig(clonePromptConfig(promptConfig));
    setIsEditing(true);
    setValidationErrors([]);
  }, [promptConfig]);

  const handleCancel = useCallback(() => {
    setEditedConfig(null);
    setIsEditing(false);
    setValidationErrors([]);
    setSaveComment("");
  }, []);

  const handleSave = useCallback(async () => {
    if (!editedConfig || !selectedPrompt) return;

    try {
      const validation = await validatePrompt(selectedPrompt, editedConfig);
      if (!validation.valid) {
        setValidationErrors(validation.errors || []);
        return;
      }
    } catch (err) {
      setError(`Validation failed: ${err.message}`);
      return;
    }

    setSaving(true);
    setValidationErrors([]);

    try {
      await updatePrompt(selectedPrompt, editedConfig, "user", saveComment);
      await loadPromptDetails();
      alert("Prompt saved successfully!");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [editedConfig, loadPromptDetails, saveComment, selectedPrompt]);

  const handleRestore = useCallback(async (versionTimestamp) => {
    if (!selectedPrompt) return;
    if (!window.confirm(`Restore prompt to version ${versionTimestamp}?`)) return;

    try {
      await restorePromptVersion(selectedPrompt, versionTimestamp, "user");
      await loadPromptDetails();
      setShowHistory(false);
      alert("Prompt restored successfully!");
    } catch (err) {
      setError(err.message);
    }
  }, [loadPromptDetails, selectedPrompt]);

  const handleReload = useCallback(async () => {
    if (!confirmDiscardChanges("Reload prompt files and discard unsaved prompt changes?")) {
      return;
    }

    try {
      await reloadPrompts();
      await loadPrompts();
      alert("Prompts reloaded from file!");
    } catch (err) {
      setError(err.message);
    }
  }, [confirmDiscardChanges, loadPrompts]);

  const currentConfig = isEditing ? editedConfig : promptConfig;

  return {
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
  };
}
