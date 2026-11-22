import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const [loaded, setLoaded] = useState(null);
  const owner = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedConfig, setEditedConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [saveComment, setSaveComment] = useState("");

  const promptConfig = loaded?.name === selectedPrompt ? loaded.config : null;

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
      return promptNames;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCancel = useCallback(() => {
    setEditedConfig(null);
    setIsEditing(false);
    setValidationErrors([]);
    setSaveComment("");
  }, []);

  const loadPromptDetails = useCallback(async (selection) => {
    if (!selection?.name || owner.current !== selection) return;
    const request = {};
    selection.detailsRequest = request;
    const current = () => owner.current === selection && selection.detailsRequest === request;
    try {
      const config = await getPrompt(selection.name);
      if (!current()) return;
      setLoaded({ name: selection.name, config });
      handleCancel();
    } catch (err) {
      if (current()) setError(err.message);
    }
  }, [handleCancel]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  useEffect(() => {
    const selection = { name: selectedPrompt };
    owner.current = selection;
    setLoaded(null);
    setShowHistory(false);
    setHistory(null);
    setSaving(false);
    handleCancel();
    void loadPromptDetails(selection);
    return () => { owner.current = null; };
  }, [handleCancel, loadPromptDetails, selectedPrompt]);

  const loadHistory = useCallback(async () => {
    const selection = owner.current;
    if (!selection?.name) return;

    try {
      const historyData = await getPromptHistory(selection.name, 20);
      if (owner.current !== selection) return;
      setHistory({ name: selection.name, versions: historyData.history || [] });
      setShowHistory(true);
    } catch (err) {
      if (owner.current === selection) setError(err.message);
    }
  }, []);

  const selectPrompt = useCallback((promptName) => {
    if (!promptName || promptName === selectedPrompt) {
      return;
    }
    if (!confirmDiscardChanges()) {
      return;
    }
    owner.current = null;
    setError(null);
    setSelectedPrompt(promptName);
  }, [confirmDiscardChanges, selectedPrompt]);

  const handleEdit = useCallback(() => {
    if (!promptConfig) return;
    setEditedConfig(clonePromptConfig(promptConfig));
    setIsEditing(true);
    setValidationErrors([]);
  }, [promptConfig]);

  const handleSave = useCallback(async () => {
    const selection = owner.current;
    if (!editedConfig || !promptConfig || selection?.name !== selectedPrompt || selection.saving) return;
    selection.saving = true;
    setSaving(true);
    setValidationErrors([]);

    try {
      let validation;
      try {
        validation = await validatePrompt(selection.name, editedConfig);
      } catch (err) {
        if (owner.current === selection) setError(`Validation failed: ${err.message}`);
        return;
      }
      if (owner.current !== selection) return;
      if (!validation.valid) {
        setValidationErrors(validation.errors || []);
        return;
      }
      await updatePrompt(selection.name, editedConfig, "user", saveComment);
      await loadPromptDetails(selection);
      if (owner.current === selection) alert("Prompt saved successfully!");
    } catch (err) {
      if (owner.current === selection) setError(err.message);
    } finally {
      selection.saving = false;
      if (owner.current === selection) setSaving(false);
    }
  }, [editedConfig, loadPromptDetails, promptConfig, saveComment, selectedPrompt]);

  const handleRestore = useCallback(async (versionTimestamp) => {
    const selection = owner.current;
    if (!selection?.name) return;
    if (!window.confirm(`Restore prompt to version ${versionTimestamp}?`)) return;

    try {
      await restorePromptVersion(selection.name, versionTimestamp, "user");
      await loadPromptDetails(selection);
      if (owner.current !== selection) return;
      setShowHistory(false);
      alert("Prompt restored successfully!");
    } catch (err) {
      if (owner.current === selection) setError(err.message);
    }
  }, [loadPromptDetails]);

  const handleReload = useCallback(async () => {
    if (!confirmDiscardChanges("Reload prompt files and discard unsaved prompt changes?")) {
      return;
    }

    try {
      await reloadPrompts();
      const promptNames = await loadPrompts();
      if (!promptNames) return;
      const selection = owner.current;
      if (promptNames.includes(selection?.name)) {
        setLoaded(null);
        await loadPromptDetails(selection);
      }
      alert("Prompts reloaded from file!");
    } catch (err) {
      setError(err.message);
    }
  }, [confirmDiscardChanges, loadPromptDetails, loadPrompts]);

  const currentConfig = isEditing && promptConfig ? editedConfig : promptConfig;

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
    history: history?.name === selectedPrompt ? history.versions : [],
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
    showHistory: showHistory && history?.name === selectedPrompt,
    validationErrors,
  };
}
