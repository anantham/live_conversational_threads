import { useCallback, useEffect, useRef, useState } from 'react';
import { recordSearchTiming } from '../services/searchTiming';

export default function useConversationSearch(documents) {
  const worker = useRef(null);
  const request = useRef(0);
  const operation = useRef(null);
  const attempts = useRef(0);
  const [status, setStatus] = useState({ stage: 'idle' });
  const [results, setResults] = useState([]);
  const stop = useCallback((outcome = 'cancelled') => {
    if (operation.current) recordSearchTiming({ count: documents.length, outcome,
      retries: attempts.current - 1, elapsedMs: performance.now() - operation.current.started });
    operation.current = null;
    const stoppedWorker = worker.current;
    worker.current = null;
    if (stoppedWorker) {
      stoppedWorker.onmessage = stoppedWorker.onerror = stoppedWorker.onmessageerror = null;
      stoppedWorker.terminate();
    }
  }, [documents]);
  useEffect(() => () => stop(), [stop]);
  const cancel = useCallback(() => { stop(); setStatus({ stage: 'cancelled' }); }, [stop]);
  const search = useCallback(query => {
    if (!query.trim() || !documents.length || operation.current) return;
    attempts.current += 1;
    const requestId = ++request.current;
    const started = performance.now();
    operation.current = { started, requestId };
    setResults([]); setStatus({ stage: 'starting', started, stageStarted: started });
    try {
      if (!worker.current) worker.current = new Worker(new URL('../services/conversationSearch.worker.js', import.meta.url), { type: 'module' });
      const activeWorker = worker.current;
      const isCurrent = () => worker.current === activeWorker && operation.current?.requestId === requestId;
      worker.current.onmessage = ({ data }) => {
        if (!isCurrent() || data.requestId !== requestId) return;
        if (data.type === 'progress') setStatus(previous => ({ ...data, started,
          stageStarted: previous.stage === data.stage ? previous.stageStarted : performance.now() }));
        if (data.type === 'results') {
          recordSearchTiming({ count: documents.length, outcome: 'success', retries: attempts.current - 1,
            elapsedMs: performance.now() - started, timings: data.timings });
          operation.current = null; attempts.current = 0;
          setResults(data.results); setStatus({ stage: 'ready' });
        }
        if (data.type === 'error') { stop('error'); setStatus({ stage: 'error', message: data.message }); }
      };
      worker.current.onerror = event => {
        if (!isCurrent()) return;
        stop('error'); setStatus({ stage: 'error', message: `On-device search could not start: ${event.message}. Text search remains available.` });
      };
      worker.current.onmessageerror = () => {
        if (!isCurrent()) return;
        stop('error'); setStatus({ stage: 'error', message: 'On-device search could not read a response. Retry meaning search or keep using text search.' });
      };
      worker.current.postMessage({ requestId, query, documents });
    } catch (error) { stop('error'); setStatus({ stage: 'error', message: `On-device search could not start: ${error.message}. Text search remains available.` }); }
  }, [documents, stop]);
  return { status, results, search, cancel };
}
