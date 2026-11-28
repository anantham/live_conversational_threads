import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { SitesRuntimeContext } from './SitesRuntimeContext';
import { normalizeProviderPreferences, readProviderPreferences, saveProviderPreferences } from '../services/cloud/sitesProviderPreferences';
import { deleteSavedProviderKey, readSavedProviderCredentials, writeSavedProviderKey, writeSavedProviderModels } from '../services/cloud/sitesProviderCredentialStore';

export default function SitesRuntimeProvider({ children }) {
  const [preferences, setPreferences] = useState(readProviderPreferences);
  const [entries, setEntries] = useState({});
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [credentialError, setCredentialError] = useState('');
  const channel = useRef(null);
  const readVersion = useRef(0);

  const reloadCredentials = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const { entries, unreadable } = await readSavedProviderCredentials();
      if (version !== readVersion.current) return;
      setEntries(entries);
      setCredentialError(unreadable ? 'A saved provider key could not be opened. Replace it in Settings.' : '');
    } catch {
      if (version === readVersion.current) setCredentialError('This browser could not open saved provider keys.');
    } finally {
      if (version === readVersion.current) setCredentialsReady(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window.BroadcastChannel === 'function') {
      channel.current = new window.BroadcastChannel('lct.sites.provider-settings');
      channel.current.onmessage = () => { void reloadCredentials(); };
    }
    void reloadCredentials();
    return () => {
      readVersion.current = readVersion.current + 1;
      channel.current?.close();
      channel.current = null;
    };
  }, [reloadCredentials]);

  const refreshProvider = useCallback(async (id, revision) => {
    const { entries } = await readSavedProviderCredentials();
    const entry = entries[id];
    if (!entry || entry.revision !== revision) throw new Error('The saved key changed. Refresh models for the current key.');
    const response = await fetch('/api/cloud/providers/check', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(9000),
      headers: { 'Content-Type': 'application/json', 'X-LCT-Key-Check': 'check-v1' },
      body: JSON.stringify({ backend: id, key: entry.key }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The connection check could not finish.');
    if (Array.isArray(result.models)) {
      if (!await writeSavedProviderModels(id, entry.revision, result.models)) {
        throw new Error('The saved key changed. Refresh models for the current key.');
      }
      channel.current?.postMessage(null);
      await reloadCredentials();
    }
    return result.message;
  }, [reloadCredentials]);

  const runtime = useMemo(() => ({
    preferences,
    keys: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.key])),
    catalogs: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.models])),
    catalogRecords: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { revision: entry.revision, fetchedAt: entry.modelsFetchedAt }])),
    credentialsReady,
    storageError,
    credentialError,
    save(patch) {
      const next = normalizeProviderPreferences({ ...preferences, ...patch });
      try { saveProviderPreferences(next); setStorageError(''); }
      catch { setStorageError('Browser storage is unavailable. Changes apply until you close or reload this tab.'); }
      setPreferences(next);
    },
    async setKey(id, key) {
      if (key) await writeSavedProviderKey(id, key);
      else await deleteSavedProviderKey(id);
      channel.current?.postMessage(null);
      await reloadCredentials();
    },
    refreshProvider,
  }), [preferences, entries, credentialsReady, storageError, credentialError, reloadCredentials, refreshProvider]);

  return <SitesRuntimeContext.Provider value={runtime}>{children}</SitesRuntimeContext.Provider>;
}

SitesRuntimeProvider.propTypes = { children: PropTypes.node };
