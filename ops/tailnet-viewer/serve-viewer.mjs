import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [release, viteModule, allowedHost, portArgument] = process.argv.slice(2);
const port = Number(portArgument);
if (!release || !viteModule || !allowedHost || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage: serve-viewer.mjs <release directory> <Vite module> <allowed host> <port 1024-65535>');
  process.exit(1);
}
const log = path.join(release, 'viewer.log');

function writeLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    if (fs.existsSync(log) && fs.statSync(log).size > 1048576) {
      fs.copyFileSync(log, path.join(release, 'viewer.previous.log'));
      fs.writeFileSync(log, '');
    }
    fs.appendFileSync(log, line);
  } catch (error) {
    console.error(`${line}Unable to write viewer log: ${error.message}`);
  }
}

function fail(error) {
  writeLog(`Viewer failed: ${error?.stack || error}`);
  process.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

try {
  const { preview } = await import(pathToFileURL(viteModule).href);
  const server = await preview({
    configFile: false,
    root: release,
    build: { outDir: path.join(release, 'dist') },
    preview: { host: '127.0.0.1', port, strictPort: true, allowedHosts: [allowedHost] },
  });
  server.httpServer.on('error', fail);
  writeLog(`Viewer listening on 127.0.0.1:${port}; allowed Tailnet host ${allowedHost}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.httpServer.close(() => process.exit(0)));
  }
} catch (error) {
  fail(error);
}
