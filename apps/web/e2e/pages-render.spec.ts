/**
 * Subject: every page renders from a cold session against the PRODUCTION
 * build (the P86/P87 class: a one-character CSS error 500'd every page while
 * all other gates stayed green). Grows with each new route — a route added
 * without joining this list should be caught in review.
 */
import { test, expect } from '@playwright/test';

const ROUTES = ['/'];

for (const route of ROUTES) {
  test(`renders ${route} with HTTP 200 and no client errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('styles actually applied (stylesheet parsed, not just served)', async ({ page }) => {
  await page.goto('/');
  // max-w-5xl on <body>: if the stylesheet failed to parse, this computed
  // style is absent even though the HTML renders.
  const maxWidth = await page.evaluate(() => getComputedStyle(document.body).maxWidth);
  expect(maxWidth).not.toBe('none');
});
