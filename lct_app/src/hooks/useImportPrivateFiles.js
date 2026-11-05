import { useCallback, useEffect, useRef, useState } from 'react';
import { useCloudTask } from './useCloudTask.js';
import { checkSiteSession } from '../services/cloud/siteSession.js';
import { privateRequest, uploadType, validatePrivateFile } from '../services/privateFiles.js';

const uncertain = 'Private save could not be confirmed. Check Private files before retrying. Your local copies are unchanged.';
const fileId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function useImportPrivateFiles(blocked) {
  const task = useCloudTask('private-conversation');
  const [status, setStatus] = useState({ state: 'checking', limits: null });
  const [saving, setSaving] = useState(false), [subject, setSubject] = useState('File');
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const alive = useRef(true), pending = useRef(null), epoch = useRef(0);
  const check = useCallback(async () => {
    if (pending.current) return;
    const version = ++epoch.current; pending.current = 'check';
    setStatus({ state: 'checking', limits: null }); setError('');
    const result = await task.run('load', signal => Promise.all([
      checkSiteSession(signal), privateRequest('/api/cloud/files/status', { signal }),
    ]));
    if (alive.current && epoch.current === version) {
      const [session, storage] = result.data || [];
      const valid = storage && typeof storage.enabled === 'boolean' && typeof storage.configured === 'boolean'
        && typeof storage.synthetic_only === 'boolean' && storage.visibility === 'private'
        && Number.isSafeInteger(storage.limits?.maxFileBytes) && storage.limits.maxFileBytes > 0;
      setStatus(!valid ? { state: 'unknown', limits: null }
        : !storage.enabled || !storage.configured || storage.synthetic_only ? { state: 'inactive', limits: null }
          : { state: session === 'signed-in' ? 'ready' : 'guest', limits: storage.limits });
    }
    if (epoch.current === version) pending.current = null;
  }, [task.run]);
  useEffect(() => {
    alive.current = true; void check();
    return () => { alive.current = false; epoch.current++; pending.current = null; };
  }, [check]);

  const save = useCallback(async (file, label) => {
    if (pending.current || blocked || status.state !== 'ready') return;
    const problem = validatePrivateFile(file, status.limits);
    if (problem) { setError(problem); return; }
    pending.current = 'save'; const version = ++epoch.current;
    setSaving(true); setSubject(label); setMessage(''); setError('');
    let sessionChecked = false;
    const result = await task.run('load', async signal => {
      const session = await checkSiteSession(signal);
      if (session !== 'signed-in') throw Object.assign(new Error('Sign in before saving a private cloud copy.'), { status: 401 });
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      sessionChecked = true;
      const receipt = await privateRequest('/api/cloud/files', { method: 'POST', file, signal });
      const saved = receipt.file;
      if (!saved || !fileId.test(saved.id) || saved.state !== 'ready' || saved.visibility !== 'private'
        || saved.filename !== file.name || saved.byte_size !== file.size || saved.content_type !== uploadType(file)) {
        throw new Error(uncertain);
      }
      return saved;
    });
    if (alive.current && epoch.current === version) {
      if (result.data) setMessage(`${label} saved to your private cloud files.`);
      else {
        if (result.error?.status === 401) setStatus({ state: 'guest', limits: status.limits });
        else if (!sessionChecked) setStatus({ state: 'unknown', limits: null });
        setError(['cancelled', 'timeout'].includes(result.outcome) ? uncertain : result.error.message);
      }
      setSaving(false);
    }
    if (epoch.current === version) pending.current = null;
  }, [blocked, status, task.run]);
  return { status, ready: status.state === 'ready', saving, subject, message, error,
    check, save, cancel: task.cancel, elapsed: task.elapsed };
}
