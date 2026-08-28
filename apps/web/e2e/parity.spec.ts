/**
 * Subject: the TaxOS-parity screens ported per docs/TAXOS-PARITY-LEDGER.md,
 * exercised against the PRODUCTION build over the journey's data (this file
 * sorts after journey.spec.ts, whose workspace and confirmed facts it
 * reuses — the journey proves the pipeline; this proves the new screens
 * render REAL content from it).
 */
import { test, expect } from '@playwright/test';

const HAS_DB = Boolean(process.env.TAXFS_TEST_DATABASE_URL);

test.describe('parity screens (forms, e-file, interview)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('Forms renders the draft return as form lines with a 1040 headline', async ({ page }) => {
    await page.goto('/forms');
    // Journey data is confirmed + computed, so real instances must render.
    await expect(page.getByTestId('form-1040')).toBeVisible();
    await expect(page.getByTestId('form-1040')).toContainText('1040');
    // Mapping defects panel absent — the mapping layer must be clean.
    await expect(page.getByTestId('forms-defects')).toHaveCount(0);
  });

  test('the official-PDF draft preview streams a real PDF for the 1040', async ({ page }) => {
    const res = await page.request.get('/api/formpdf?form_id=1040');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    const body = await res.body();
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('E-file sheet shows reconciliation targets and federal form lines', async ({ page }) => {
    await page.goto('/efile');
    await expect(page.getByTestId('efile-recon')).toBeVisible();
    await expect(page.getByTestId('efile-recon')).toContainText('Filing status');
    await expect(page.getByTestId('efile-recon')).toContainText('Federal AGI');
    await expect(page.getByTestId('efile-il')).toBeVisible();
    // The journey has real income — the empty-run guard must NOT show.
    await expect(page.getByTestId('efile-empty-run')).toHaveCount(0);
  });

  test('Interview asks the IL residency attestation and records the answer', async ({ page }) => {
    await page.goto('/interview');
    const q = page.getByTestId('question-gap-att-residency');
    await expect(q).toBeVisible();
    await expect(q.getByTestId('attestation-banner')).toBeVisible();
    await q.getByTestId('attest-yes').click();
    await page.waitForURL(/\/interview/);
    // Answered → the gap closes and the question is gone.
    await expect(page.getByTestId('question-gap-att-residency')).toHaveCount(0);
  });
});
