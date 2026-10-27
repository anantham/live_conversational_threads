import { useEffect, useState } from 'react';
// Bounded browser instrumentation only; no transcript, account or network payload.
export function useReplayDiagnostics(active) {
  const [stats, setStats] = useState({ frame_samples: 0, frame_p95_ms: null, frame_max_ms: null, long_tasks: null, heap_samples: [], hidden_seconds: 0 });
  useEffect(() => {
    if (!active) return;
    let running = true, frame, previous, max = 0, frames = 0, tasks = null, hidden = 0, lastHeap = 0;
    const recent = [], heap = [];
    const tick = now => {
      if (!running) return;
      if (previous !== undefined && document.visibilityState === 'visible') { const gap = now - previous; recent.push(gap); if (recent.length > 3600) recent.shift(); max = Math.max(max, gap); frames++; }
      previous = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    let observer;
    try { observer = new PerformanceObserver(list => { tasks = (tasks || 0) + list.getEntries().length; }); observer.observe({ entryTypes: ['longtask'] }); tasks = 0; } catch { tasks = null; }
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') hidden++;
      if (Date.now() - lastHeap >= 60000) {
        const bytes = performance.memory?.usedJSHeapSize;
        heap.push({ at: Date.now(), bytes: Number.isFinite(bytes) ? bytes : null }); if (heap.length > 30) heap.shift(); lastHeap = Date.now();
      }
      const sorted = [...recent].sort((a,b) => a-b);
      setStats({ frame_samples: frames, frame_p95_ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
        frame_max_ms: max, long_tasks: tasks, heap_samples: [...heap], hidden_seconds: hidden });
    }, 1000);
    return () => { running = false; cancelAnimationFrame(frame); clearInterval(timer); observer?.disconnect(); };
  }, [active]);
  return stats;
}
