import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Serverless Proxy Security Guards', () => {
  it('must not contain console.log or print statements that could leak API keys', () => {
    // Three levels up: this file lives in src/services/serverless/, the proxy
    // routes in lct_app/api/proxy. The old '../../api/proxy' resolved to the
    // nonexistent src/api/proxy, so the existsSync escape hatch silently
    // skipped this guard for its entire life. Resolve the REAL dir and fail
    // loudly if it ever moves.
    const proxyDir = path.resolve(__dirname, '../../../api/proxy');
    expect(fs.existsSync(proxyDir), `proxy dir missing at ${proxyDir}`).toBe(true);

    const files = fs.readdirSync(proxyDir);
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.ts')) {
        const filePath = path.join(proxyDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        
        // ADR-060: Proxy routes hold no state and must NEVER log the request or headers
        // to prevent the user's BYOK key from leaking into serverless observability logs.
        expect(content).not.toMatch(/console\.log\(/);
        expect(content).not.toMatch(/console\.error\(/);
        expect(content).not.toMatch(/console\.warn\(/);
        expect(content).not.toMatch(/console\.info\(/);
        expect(content).toMatch(/NO_LOG_BYOK_KEY_ASSERTION/); // Explicit assertion marker in code
      }
    }
  });
});
