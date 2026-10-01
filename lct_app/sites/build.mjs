import { copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Paths are relative to the source tree, independent of the caller's cwd.
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ root, configFile: fileURLToPath(new URL('./frontend.config.mjs', import.meta.url)) });
await copyFile(new URL('../public/favicon.svg', import.meta.url), new URL('../dist/client/favicon.svg', import.meta.url));
await build({ root, configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)) });
// Check both outputs: a clean client alone cannot prove the Worker output is
// free of unrelated public artifacts. Refuse packaging when that contract drifts.
for (const [directory, expected] of [
  ['../dist/client/', ['assets', 'favicon.svg', 'index.html']],
  ['../dist/server/', ['index.js']],
]) {
  const actual = await readdir(new URL(directory, import.meta.url));
  if (actual.sort().join('\n') !== expected.sort().join('\n')) {
    throw new Error('Unexpected files in ' + directory + '; refuse to publish this Site build.');
  }
}
