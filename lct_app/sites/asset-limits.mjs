import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const MAX_SITE_ASSET_BYTES = 25 * 1024 * 1024;

// Apply the hosting contract to every published client file, not only WASM.
export async function assertSiteAssetLimits(directory) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Site assets must be a regular directory.');
  let files = 0;
  let largest = { path: '', bytes: 0 };
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name);
      const name = relative(directory, filename);
      if (entry.isSymbolicLink()) throw new Error(`Site asset cannot be a symbolic link: ${name}`);
      if (entry.isDirectory()) { await visit(filename); continue; }
      const stat = await lstat(filename);
      if (!stat.isFile()) throw new Error(`Site asset must be a regular file: ${name}`);
      if (stat.size > MAX_SITE_ASSET_BYTES) {
        throw new Error(`Site asset ${name} is ${stat.size} bytes; maximum is ${MAX_SITE_ASSET_BYTES} bytes (25 MiB).`);
      }
      files += 1;
      if (stat.size > largest.bytes) largest = { path: name, bytes: stat.size };
    }
  }
  await visit(directory);
  return { files, largest };
}
