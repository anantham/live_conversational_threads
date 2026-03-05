import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiFetch } from "../services/apiClient";

const POLL_INTERVAL_MS = 30000; // 30 seconds

/**
 * Status indicator dot colors:
 * - green: healthy and using local backend
 * - yellow: healthy but using Modal (cloud) fallback
 * - red: unhealthy / unavailable
 */
function StatusDot({ healthy, isModal, url, model, latencyMs, error }) {
  let colorClass = "bg-red-500";
  if (healthy) {
    colorClass = isModal ? "bg-yellow-500" : "bg-green-500";
  }

  // Build detailed tooltip
  const lines = [];
  if (healthy) {
    lines.push(isModal ? "Healthy (Modal Cloud)" : "Healthy (Local GPU)");
  } else {
    lines.push("Unavailable");
  }
  if (url) lines.push(`URL: ${url}`);
  if (model) lines.push(`Model: ${model}`);
  if (latencyMs) lines.push(`Latency: ${latencyMs}ms`);
  if (error) lines.push(`Error: ${error}`);

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorClass} cursor-help`}
      title={lines.join("\n")}
    />
  );
}

StatusDot.propTypes = {
  error: PropTypes.string,
  healthy: PropTypes.bool.isRequired,
  isModal: PropTypes.bool,
  latencyMs: PropTypes.number,
  model: PropTypes.string,
  url: PropTypes.string,
};

export default function ServiceStatus({ className = "" }) {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStatus = async () => {
    try {
      const response = await apiFetch("/api/import/status");
      if (!response.ok) {
        throw new Error(`Status check failed: ${response.status}`);
      }
      const data = await response.json();
      setServices(data.services);
      setError(null);
    } catch (err) {
      console.warn("[ServiceStatus] Failed to fetch status:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const intervalId = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);

  if (loading && !services) {
    return (
      <div className={`flex items-center gap-3 text-xs text-gray-400 ${className}`}>
        <span className="animate-pulse">Checking services...</span>
      </div>
    );
  }

  if (error && !services) {
    return (
      <div className={`flex items-center gap-3 text-xs text-red-400 ${className}`}>
        <span>Status unavailable</span>
      </div>
    );
  }

  const whisperx = services?.whisperx;
  const modalWhisperx = services?.modal_whisperx;
  const llm = services?.llm;

  // Determine active STT backend
  const sttHealthy = whisperx?.healthy || modalWhisperx?.healthy;
  const sttIsModal = !whisperx?.healthy && modalWhisperx?.healthy;
  const activeStt = sttIsModal ? modalWhisperx : whisperx;

  return (
    <div className={`flex items-center gap-4 text-xs text-gray-500 ${className}`}>
      {/* WhisperX / STT Status */}
      <div className="flex items-center gap-1.5">
        <StatusDot
          healthy={sttHealthy}
          isModal={sttIsModal}
          url={activeStt?.url}
          latencyMs={activeStt?.latency_ms}
          error={activeStt?.error}
        />
        <span className="hidden sm:inline">STT</span>
        {sttIsModal && <span className="text-yellow-600 text-[10px]">(Modal)</span>}
      </div>

      {/* LLM Status */}
      <div className="flex items-center gap-1.5">
        <StatusDot
          healthy={llm?.healthy}
          isModal={llm?.backend === "modal"}
          url={llm?.url}
          model={llm?.model}
          latencyMs={llm?.latency_ms}
          error={llm?.error}
        />
        <span className="hidden sm:inline">LLM</span>
        {llm?.backend === "modal" && llm?.healthy && (
          <span className="text-yellow-600 text-[10px]">(Modal)</span>
        )}
      </div>
    </div>
  );
}

ServiceStatus.propTypes = {
  className: PropTypes.string,
};
