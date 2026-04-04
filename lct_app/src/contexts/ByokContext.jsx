import { useCallback, useMemo, useState } from "react";
import PropTypes from "prop-types";

import { createByokSession } from "../services/byokApi";
import { ByokContext } from "./byokContext";
const SESSION_REFRESH_BUFFER_MS = 30_000;

function parseExpiresAt(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function ByokProvider({ children }) {
  const [apiKey, setApiKeyState] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [sessionExpiresAt, setSessionExpiresAt] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const clearSession = useCallback(() => {
    setSessionToken("");
    setSessionExpiresAt("");
  }, []);

  const setApiKey = useCallback((nextValue) => {
    const normalized = String(nextValue || "");
    if (normalized === apiKey) return;
    setApiKeyState(normalized);
    setStatus("idle");
    setError("");
    clearSession();
  }, [apiKey, clearSession]);

  const clearByok = useCallback(() => {
    setApiKeyState("");
    setStatus("idle");
    setError("");
    clearSession();
  }, [clearSession]);

  const sessionIsFresh = useCallback(() => {
    if (!sessionToken) return false;
    const expiresAtMs = parseExpiresAt(sessionExpiresAt);
    if (!expiresAtMs) return false;
    return Date.now() + SESSION_REFRESH_BUFFER_MS < expiresAtMs;
  }, [sessionExpiresAt, sessionToken]);

  const refreshSession = useCallback(async () => {
    const trimmedKey = String(apiKey || "").trim();
    if (!trimmedKey) {
      clearSession();
      setStatus("idle");
      setError("");
      return null;
    }

    setStatus("connecting");
    setError("");
    try {
      const payload = await createByokSession({ apiKey: trimmedKey });
      setSessionToken(String(payload?.byok_session_token || ""));
      setSessionExpiresAt(String(payload?.expires_at || ""));
      setStatus("ready");
      return String(payload?.byok_session_token || "");
    } catch (sessionError) {
      clearSession();
      setStatus("error");
      const message = sessionError instanceof Error
        ? sessionError.message
        : "Failed to validate the OpenAI key.";
      setError(message);
      throw sessionError;
    }
  }, [apiKey, clearSession]);

  const ensureSessionToken = useCallback(async () => {
    const trimmedKey = String(apiKey || "").trim();
    if (!trimmedKey) return null;
    if (sessionIsFresh()) {
      return sessionToken;
    }
    return refreshSession();
  }, [apiKey, refreshSession, sessionIsFresh, sessionToken]);

  const value = useMemo(() => ({
    apiKey,
    clearByok,
    ensureSessionToken,
    error,
    hasApiKey: Boolean(String(apiKey || "").trim()),
    isSessionReady: sessionIsFresh(),
    refreshSession,
    sessionExpiresAt,
    sessionToken,
    setApiKey,
    status,
  }), [
    apiKey,
    clearByok,
    ensureSessionToken,
    error,
    refreshSession,
    sessionExpiresAt,
    sessionIsFresh,
    sessionToken,
    setApiKey,
    status,
  ]);

  return (
    <ByokContext.Provider value={value}>
      {children}
    </ByokContext.Provider>
  );
}

ByokProvider.propTypes = {
  children: PropTypes.node.isRequired,
};
