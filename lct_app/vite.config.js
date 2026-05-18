import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";

// Backend port discovery: read from .backend-port (written by the repo launchers),
// fall back to VITE_BACKEND_PORT env var, then default 43180.
function resolveBackendPort() {
  try {
    const portFile = new URL("../.backend-port", import.meta.url);
    const port = fs.readFileSync(portFile, "utf-8").trim();
    if (/^\d+$/.test(port)) return Number(port);
  } catch {
    // file doesn't exist — use fallback
  }
  return Number(process.env.VITE_BACKEND_PORT) || 43180;
}

const backendPort = resolveBackendPort();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    globals: false,
    // Vitest auto-discovers *.test.{js,jsx,ts,tsx} under src/.
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
    // Keep e2e (Playwright) and unit (vitest) suites separate.
    exclude: ["tests/**", "node_modules/**", "dist/**", "test-results/**"],
  },
  server: {
    port: Number(process.env.FRONTEND_PORT) || 43173,
    strictPort: true,
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
      // NOTE: no top-level "/import" proxy entry — that path is a React
      // route (lct_app/src/routes/AppRoutes.jsx). Backend import endpoints
      // all live under /api/import/* which the "/api" proxy above already
      // catches. Adding "/import" here intercepts the browser navigation
      // to the React page and forwards the raw HTML request to FastAPI,
      // which returns a JSON 401 / 404 — user sees raw JSON instead of
      // the React app.
    },
  },
});
