import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { SitesRuntimeContext } from './SitesRuntimeContext';
import { normalizeProviderPreferences, readProviderPreferences, saveProviderPreferences } from '../services/cloud/sitesProviderPreferences';

export default function SitesRuntimeProvider({ children }) {
  const [preferences, setPreferences] = useState(readProviderPreferences);
  const [keys, setKeys] = useState({});
  const [storageError, setStorageError] = useState('');
  const runtime = useMemo(() => ({
    preferences,
    keys,
    storageError,
    save(patch) {
      const next = normalizeProviderPreferences({ ...preferences, ...patch });
      try { saveProviderPreferences(next); setStorageError(''); }
      catch { setStorageError('Browser storage is unavailable. Changes apply until you close or reload this tab.'); }
      setPreferences(next);
    },
    setKey(id, key) { setKeys(previous => ({ ...previous, [id]: key })); },
  }), [preferences, keys, storageError]);
  return <SitesRuntimeContext.Provider value={runtime}>{children}</SitesRuntimeContext.Provider>;
}

SitesRuntimeProvider.propTypes = { children: PropTypes.node };
