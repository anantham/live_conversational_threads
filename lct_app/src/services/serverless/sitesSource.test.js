// @vitest-environment node
// Test intent: tests/intent/sites-parallel-site.md. All fixture content is synthetic.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportSiteSource } from '../../../sites/export-source.mjs';
import { copySiteStorageMetadata } from '../../../sites/storage-packaging.mjs';

const scratch = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lct-sites-source-'));
  scratch.push(root);
  const source = join(root, 'frontend');
  const output = join(root, 'export');
  function file(name, content = 'fixture-source') {
    const target = join(source, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const name of [
    'index.html', 'package-lock.json', 'public/favicon.svg',
    'api/proxy/_shared.js', 'api/proxy/chat.js', 'api/proxy/realtime-token.js',
    'sites/worker.js', 'sites/vite.config.mjs', 'sites/frontend.config.mjs', 'sites/build.mjs',
    'sites/storage-packaging.mjs', 'sites/storage.js', 'sites/storagePolicy.js', 'sites/storageRecovery.js',
    'sites/publicThreads.js', 'sites/publicThreadsPolicy.js',
    'sites/soniox.js', 'sites/sonioxPolicy.js',
    'db/schema.ts', 'drizzle.config.ts',
    'src/main.jsx', 'src/index.css', 'src/services/serverless/prompts.json',
  ]) file(name);
  file('.openai/hosting.json', JSON.stringify({ project_id: 'appgprj_fixture', d1: 'DB', r2: 'BUCKET' }));
  file('drizzle/0000_test.sql', 'CREATE TABLE test (id text);');
  file('drizzle/meta/_journal.json', JSON.stringify({ version: '7', dialect: 'sqlite', entries: [
    { idx: 0, version: '6', when: 1, tag: '0000_test', breakpoints: true },
  ] }));
  file('drizzle/meta/0000_snapshot.json', JSON.stringify({ dialect: 'sqlite', tables: { test: {} } }));
  file('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'legacy', dev: 'legacy-dev' } }));
  return { source, output, file };
}

describe('Site source export public API', () => {
  it('exports required app source and only the approved public asset', () => {
    const { source, output, file } = fixture();
    for (const name of [
      '.env', '.openai/private-token.json', 'docs/WORKLOG.md', 'public/w/fixture.enc',
      'public/experiments/fixture.threads', 'src/private-recording.json',
      'src/main.test.jsx', 'src/fixtures/private.js',
    ]) file(name, 'fixture-excluded');
    const result = exportSiteSource(source, output);
    expect(result.directory).toBe(output);
    expect(readFileSync(join(output, 'src/main.jsx'), 'utf8')).toBe('fixture-source');
    expect(JSON.parse(readFileSync(join(output, '.openai/hosting.json'), 'utf8')).d1).toBe('DB');
    expect(readFileSync(join(output, 'drizzle/0000_test.sql'), 'utf8')).toContain('CREATE TABLE');
    expect(readdirSync(join(output, 'public'))).toEqual(['favicon.svg']);
    expect(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).scripts).toEqual({ build: 'node sites/build.mjs' });
    for (const name of ['.env', '.openai/private-token.json', 'docs', 'src/private-recording.json', 'src/main.test.jsx', 'src/fixtures']) {
      expect(existsSync(join(output, name))).toBe(false);
    }
  });

  it('refuses a nonempty destination and preserves existing content', () => {
    const { source, output } = fixture();
    mkdirSync(output);
    writeFileSync(join(output, 'keep.txt'), 'fixture-existing');
    expect(() => exportSiteSource(source, output)).toThrow('must be empty');
    expect(readdirSync(output)).toEqual(['keep.txt']);
    expect(readFileSync(join(output, 'keep.txt'), 'utf8')).toBe('fixture-existing');
    expect(() => exportSiteSource(source, join(source, 'nested'))).toThrow('outside the frontend');
  });

  it('rejects source symlinks before creating any output', () => {
    const { source, output } = fixture();
    const outside = join(dirname(source), 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(source, 'src/external'), 'junction');
    expect(() => exportSiteSource(source, output)).toThrow('cannot contain symlinks');
    expect(existsSync(output)).toBe(false);
  });

  it('copies only validated storage metadata into the build artifact', async () => {
    const { source, output, file } = fixture();
    file('drizzle/private.sql', 'secret');
    await expect(copySiteStorageMetadata(source, output)).rejects.toThrow('Unexpected Site Drizzle');
    expect(existsSync(output)).toBe(false);
    rmSync(join(source, 'drizzle/private.sql'));
    await copySiteStorageMetadata(source, output);
    expect(readdirSync(join(output, '.openai'))).toEqual(['drizzle', 'hosting.json']);
    expect(readFileSync(join(output, '.openai/drizzle/0000_test.sql'), 'utf8')).toBe('CREATE TABLE test (id text);');
    expect(readdirSync(join(output, '.openai/drizzle/meta')).sort()).toEqual(['0000_snapshot.json', '_journal.json']);
    writeFileSync(join(output, '.openai/private.txt'), 'stale private data');
    await expect(copySiteStorageMetadata(source, output)).rejects.toThrow('Unexpected Site build metadata path');
  });

  it('rejects malformed and oversized metadata before export', () => {
    const { source, output, file } = fixture();
    file('.openai/hosting.json', JSON.stringify({ project_id: 'appgprj_fixture', d1: 'DB', r2: 'BUCKET', secret: 'bad' }));
    expect(() => exportSiteSource(source, output)).toThrow('hosting manifest');
    expect(existsSync(output)).toBe(false);
    file('.openai/hosting.json', JSON.stringify({ project_id: 'appgprj_fixture', d1: 'DB', r2: 'BUCKET' }));
    file('drizzle/0000_test.sql', 'x'.repeat(65537));
    expect(() => exportSiteSource(source, output)).toThrow('Invalid Site storage metadata file');
    expect(existsSync(output)).toBe(false);
  });

  it('rejects a symlinked migration directory before export', () => {
    const { source, output } = fixture();
    const outside = join(dirname(source), 'outside');
    mkdirSync(outside);
    rmSync(join(source, 'drizzle/meta'), { recursive: true });
    symlinkSync(outside, join(source, 'drizzle/meta'), 'junction');
    expect(() => exportSiteSource(source, output)).toThrow('Invalid Site storage metadata directory');
    expect(existsSync(output)).toBe(false);
  });
});
