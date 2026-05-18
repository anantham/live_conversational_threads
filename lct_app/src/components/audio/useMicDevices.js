import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "lct_preferred_mic_device_id";

/**
 * Enumerates available audio input devices and tracks the user's selection.
 * Persists the preferred device to localStorage across sessions.
 *
 * Returns:
 *   devices       - array of { deviceId, label } for audio inputs
 *   selectedId    - currently selected deviceId (empty string = browser default)
 *   setSelectedId - setter that also persists to localStorage
 *   refresh       - re-run enumeration (call after getUserMedia permission is granted)
 */
export default function useMicDevices() {
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedIdState] = useState(
    () => localStorage.getItem(STORAGE_KEY) || ""
  );

  const refresh = useCallback(async () => {
    try {
      // Same insecure-context gating as getUserMedia — bail quietly when
      // navigator.mediaDevices is undefined (plain http on a LAN IP).
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = all
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 6)}`,
        }));
      setDevices(audioInputs);
    } catch {
      // Permission not granted yet or API unavailable — silently ignore
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-enumerate when devices change (plug/unplug)
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);

  const setSelectedId = useCallback((id) => {
    const normalized = String(id || "").trim();
    setSelectedIdState(normalized);
    if (normalized) {
      localStorage.setItem(STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  return { devices, selectedId, setSelectedId, refresh };
}
