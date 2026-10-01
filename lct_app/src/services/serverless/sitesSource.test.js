// @vitest-environment node
// Test intent: tests/intent/sites-parallel-site.md. All fixture content is synthetic.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportSiteSource } from '../../../sites/export-source.mjs';

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
    'src/main.jsx', 'src/index.css', 'src/services/serverless/prompts.json',
  ]) file(name);
  file('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'legacy', dev: 'legacy-dev' } }));
  return { source, output, file };
}

describe('Site source export public API', () => {
  it('exports required app source and only the approved public asset', () => {
    const { source, output, file } = fixture();
    for (const name of [
      '.env', '.openai/hosting.json', 'docs/WORKLOG.md', 'public/w/fixture.enc',
      'public/experiments/fixture.threads', 'src/private-recording.json',
      'src/main.test.jsx', 'src/fixtures/private.js',
    ]) file(name, 'fixture-excluded');
    const result = exportSiteSource(source, output);
    expect(result.directory).toBe(output);
    expect(readFileSync(join(output, 'src/main.jsx'), 'utf8')).toBe('fixture-source');
    expect(readdirSync(join(output, 'public'))).toEqual(['favicon.svg']);
    expect(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8')).scripts).toEqual({ build: 'node sites/build.mjs' });
    for (const name of ['.env', '.openai', 'docs', 'src/private-recording.json', 'src/main.test.jsx', 'src/fixtures']) {
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
});
