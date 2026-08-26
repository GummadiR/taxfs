import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests are *.test.ts; Playwright specs are *.spec.ts and are
    // deliberately excluded — they run only via the e2e gate against the
    // production build (Blueprint N7).
    include: ['packages/**/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
});
