/**
 * Subject: e2e server-reuse guard (the P86 stale-dev-server class).
 * Negative test: without the explicit PW_REUSE=1 opt-in, the Playwright
 * config must refuse to reuse an existing server. If someone flips the
 * default to `true`, this test goes red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('playwright config guard', () => {
  it('reuseExistingServer is gated on PW_REUSE=1, never a default', () => {
    const config = readFileSync(fileURLToPath(new URL('../playwright.config.ts', import.meta.url)), 'utf8');
    expect(config).toMatch(/REUSE_SERVER = process\.env\.PW_REUSE === '1'/);
    expect(config).toMatch(/reuseExistingServer: REUSE_SERVER/);
    expect(config).not.toMatch(/reuseExistingServer:\s*true/);
  });
});
