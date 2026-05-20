import { useCallback, useEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import AppRoutes from "./routes/AppRoutes";
import { ByokProvider } from "./contexts/ByokContext.jsx";
import { UploadProvider } from "./contexts/UploadContext";
import UploadToast from "./components/upload/UploadToast";
import BetaGate from "./components/BetaGate";
import { apiFetch } from "./services/apiClient";

export default function App() {
  // Backend reachability gate. The frontend is public (Vercel) but the
  // backend is served over a private Tailscale network — off-network
  // visitors can load the page but can't reach the API. Probe the health
  // endpoint once on load; show a private-beta message instead of a
  // broken app full of fetch errors.
  const [backendState, setBackendState] = useState("checking");

  const probeBackend = useCallback(async () => {
    setBackendState("checking");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await apiFetch("/api/import/health", {
        signal: controller.signal,
      });
      setBackendState(resp.ok ? "online" : "offline");
    } catch {
      setBackendState("offline");
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void probeBackend();
  }, [probeBackend]);

  if (backendState === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      </div>
    );
  }

  if (backendState === "offline") {
    return <BetaGate onRetry={probeBackend} />;
  }

  return (
    <BrowserRouter>
      <ByokProvider>
        <UploadProvider>
          <AppRoutes />
          <UploadToast />
        </UploadProvider>
      </ByokProvider>
    </BrowserRouter>
  );
}
