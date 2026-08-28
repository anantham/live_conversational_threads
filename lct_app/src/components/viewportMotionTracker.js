/**
 * Test intent:
 * - Programmatic camera work remains classified as programmatic until its
 *   animation settles, including APIs that do not return a promise.
 * - The final real ReactFlow zoom becomes the next user gesture's baseline.
 * - Overlapping camera operations cannot let an older completion clear a
 *   newer operation or overwrite its settled zoom.
 * - A real pointer/touch event remains user-driven even when it interrupts an
 *   in-flight programmatic animation.
 * - An unknown expected zoom never becomes a fabricated zero baseline.
 */

export function createViewportMotionTracker({
  getZoom,
  schedule = (callback, delay) => window.setTimeout(callback, delay),
  cancel = (timer) => window.clearTimeout(timer),
  settlePaddingMs = 120,
} = {}) {
  let generation = 0;
  let active = false;
  let settledZoom = null;
  let fallbackTimer = null;

  const updateSettledZoom = (zoom) => {
    if (zoom == null || zoom === "") return settledZoom;
    const numericZoom = Number(zoom);
    if (Number.isFinite(numericZoom)) settledZoom = numericZoom;
    return settledZoom;
  };

  const finish = (token) => {
    if (token !== generation) return false;
    if (fallbackTimer != null) {
      cancel(fallbackTimer);
      fallbackTimer = null;
    }
    updateSettledZoom(getZoom?.());
    active = false;
    return true;
  };

  const run = (operation, { expectedZoom = null, duration = 0 } = {}) => {
    generation += 1;
    const token = generation;
    active = true;
    updateSettledZoom(expectedZoom);
    if (fallbackTimer != null) cancel(fallbackTimer);

    let result;
    try {
      result = operation?.();
    } catch (error) {
      finish(token);
      throw error;
    }

    if (result && typeof result.finally === "function") {
      result.finally(() => finish(token));
    }
    const delay = Math.max(0, Number(duration) || 0) + Math.max(0, settlePaddingMs);
    fallbackTimer = schedule(() => finish(token), delay);
    return result;
  };

  return {
    run,
    updateSettledZoom,
    getSettledZoom: () => settledZoom,
    isActive: () => active,
    interruptForUserGesture: (event) => {
      if (!event) return false;
      generation += 1;
      active = false;
      if (fallbackTimer != null) cancel(fallbackTimer);
      fallbackTimer = null;
      updateSettledZoom(getZoom?.());
      return true;
    },
    // ReactFlow supplies no event for ordinary API-driven motion. Some camera
    // paths can still surface an event-shaped settle callback, so an active
    // operation remains programmatic until a real onMoveStart interrupts it.
    isProgrammaticEvent: (event) => active || !event,
    dispose: () => {
      generation += 1;
      active = false;
      if (fallbackTimer != null) cancel(fallbackTimer);
      fallbackTimer = null;
    },
  };
}
