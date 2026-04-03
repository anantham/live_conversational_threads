import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";

// Backend port discovery: read from .backend-port file (written by start.sh),
// fall back to VITE_BACKEND_PORT env var, then default 8000.
function resolveBackendPort() {
  try {
    const portFile = new URL("../.backend-port", import.meta.url);
    const port = fs.readFileSync(portFile, "utf-8").trim();
    if (/^\d+$/.test(port)) return Number(port);
  } catch {
    // file doesn't exist — use fallback
  }
  return Number(process.env.VITE_BACKEND_PORT) || 8000;
}

const backendPort = resolveBackendPort();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Proxy all backend routes to the Python backend — eliminates CORS in dev.
      // Routes are mixed: /api/..., /conversations/..., /save_json/, /export/..., etc.
      "/api": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
      "/conversations": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/save_json": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/get_chunks": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/generate": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/export": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      "/import": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
});
