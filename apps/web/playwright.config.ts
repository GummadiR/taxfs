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

/** With a database available, e2e runs the app in LOCAL OPERATOR mode over
 *  the real migrations + RLS (fresh taxfs_e2e database per run). Without
 *  one, only the static specs run and app specs skip themselves loudly. */
const ADMIN_DB = process.env.TAXFS_TEST_DATABASE_URL;
// Mirrors e2eAppUrl in e2e/setup-db.mjs (config cannot import the .mjs).
function appUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = '/taxfs_e2e';
  url.username = 'taxfs_app';
  url.password = 'taxfs_app_test_pw';
  return url.href;
}
const appEnv: Record<string, string> = ADMIN_DB
  ? { TAXFS_LOCAL_OPERATOR: '1', TAXFS_DATABASE_URL: appUrl(ADMIN_DB) }
  : {};

export default defineConfig({
  testDir: './e2e',
  // App specs mutate one shared workspace; serial keeps the journey coherent.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://localhost:3100' },
  webServer: {
    // DB prep runs INSIDE the webServer command: Playwright boots this
    // before globalSetup, so a globalSetup-based prep raced the app.
    command: ADMIN_DB ? 'node e2e/setup-db.mjs && pnpm start --port 3100' : 'pnpm start --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: REUSE_SERVER,
    timeout: 60_000,
    env: { ...process.env as Record<string, string>, ...appEnv },
  },
});
