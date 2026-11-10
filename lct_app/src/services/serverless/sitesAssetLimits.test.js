// @vitest-environment node
// Intent: tests/intent/sites-cpu-search-runtime.md. Isolated sparse files only.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSiteAssetLimits, MAX_SITE_ASSET_BYTES } from '../../../sites/asset-limits.mjs';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lct-asset-limit-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function asset(name, size) {
  const path = join(root, name);
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(path, ''); await truncate(path, size); return path;
}

it('accepts the hosting boundary and reports the actual largest published file', async () => {
  await asset('assets/runtime.wasm', MAX_SITE_ASSET_BYTES);
  await asset('index.html', 20);
  expect(await assertSiteAssetLimits(root)).toEqual({ files: 2, largest: { path: join('assets', 'runtime.wasm'), bytes: 26214400 } });
});

it.each(['runtime.wasm', 'future-model.bin', 'app.js'])('refuses one byte over the limit for %s without changing the file', async name => {
  const path = await asset('assets/' + name, MAX_SITE_ASSET_BYTES + 1);
  await expect(assertSiteAssetLimits(root)).rejects.toThrow(/26214401 bytes; maximum is 26214400/);
  expect((await stat(path)).size).toBe(26214401);
});

it('rejects linked assets instead of publishing files outside the build', async ctx => {
  await asset('assets/real.bin', 1);
  try {
    await symlink(join(root, 'assets', 'real.bin'), join(root, 'assets', 'linked.bin'));
  } catch (error) {
    // Windows only lets a process create symlinks with SeCreateSymbolicLinkPrivilege (an
    // elevated shell or Developer Mode). Without it this scenario cannot be built at all,
    // so report a visible skip. Anything else, and EPERM on any other OS, is a real failure.
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    ctx.skip('Windows denied symlink creation (needs elevation or Developer Mode)');
  }
  await expect(assertSiteAssetLimits(root)).rejects.toThrow('symbolic link');
});
