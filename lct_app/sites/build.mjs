import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Paths are relative to the source tree, independent of the caller's cwd.
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ root, configFile: fileURLToPath(new URL('./frontend.config.mjs', import.meta.url)) });
await copyFile(new URL('../public/favicon.svg', import.meta.url), new URL('../dist/client/favicon.svg', import.meta.url));
await build({ root, configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)) });
