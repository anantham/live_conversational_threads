import handler from "../api/public-drive.js";

// Exercise the actual serverless handler locally, ahead of the Python /api
// proxy. No backend credential or Asus service is involved in public reading.
export function publicDrivePlugin() {
  return {
    name: "local-public-drive",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname !== "/api/public-drive") return next();
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        try {
          const response = await handler(new Request(url, { method: req.method, headers: req.headers, signal: controller.signal }));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(new Uint8Array(await response.arrayBuffer()));
        } catch {
          res.statusCode = 502;
          res.end('{"message":"The local public Drive loader could not complete the request."}');
        }
      });
    },
  };
}
