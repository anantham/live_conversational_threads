// @vitest-environment node
// Intent: exercise the real Vite config boundary. Every build mode must refuse
// browser credentials without echoing them; absent/empty values remain usable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const configFile = fileURLToPath(new URL('../../vite.config.js', import.meta.url));
afterEach(() => vi.unstubAllEnvs());

describe('browser build credential boundary', () => {
  for (const mode of ['production', 'staging']) {
    it(`refuses a browser credential in ${mode} without disclosing it`, async () => {
      const sentinel = 'manufactured-secret-must-never-be-output';
      vi.stubEnv('VITE_AUTH_TOKEN', sentinel);
      let failure;
      try {
        await resolveConfig({ root, configFile, logLevel: 'silent' }, 'build', mode);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('VITE_AUTH_TOKEN');
      expect(failure.message).not.toContain(sentinel);
    });
  }

  it('allows a build with no configured browser credential', async () => {
    vi.stubEnv('VITE_AUTH_TOKEN', '');
    const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'build');
    expect(config.command).toBe('build');
    expect(config.env.VITE_AUTH_TOKEN).toBe('');
  });

  it('preserves existing private development configuration', async () => {
    vi.stubEnv('VITE_AUTH_TOKEN', 'manufactured-private-dev-token');
    const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'serve');
    expect(config.env.VITE_AUTH_TOKEN).toBe('manufactured-private-dev-token');
  });
});
