import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * E2E ALWAYS runs against a fresh PRODUCTION server (Blueprint §1.2 P86/P87:
 * a stale dev server let 61 green specs hide a site-wide 500). Reusing an
 * existing server requires the explicit opt-in PW_REUSE=1 — never a default.
 * The production build must exist before this runs (the gate chain builds
 * first); a readable error beats next start's own failure mode.
 */
export const REUSE_SERVER = process.env.PW_REUSE === '1';

const buildId = fileURLToPath(new URL('./.next/BUILD_ID', import.meta.url));
if (!existsSync(buildId) && !REUSE_SERVER) {
  throw new Error('No production build found (.next/BUILD_ID missing). Run `pnpm build` first — e2e tests the build the user runs.');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  use: { baseURL: 'http://localhost:3100' },
  webServer: {
    command: 'pnpm start --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: REUSE_SERVER,
    timeout: 60_000,
  },
});
