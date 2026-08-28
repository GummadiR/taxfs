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

test.describe('Add Data (structured entry)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('the 2024 worksheet computes BOTH carryovers and saves them (P40/P66)', async ({ page }) => {
    await page.goto('/data');
    await page.getByTestId('wk-toggle').click();
    await page.getByTestId('wk-taxable-income').fill('100000');
    await page.getByTestId('wk-line7').fill('1000');
    await page.getByTestId('wk-line15').fill('-48842');
    await page.getByTestId('wk-line21').fill('-3000');
    await page.getByTestId('wk-compute').click();
    await page.waitForURL(/\/data\?msg=/);
    await expect(page.getByTestId('data-msg')).toContainText('SAVED');
    await expect(page.getByTestId('data-msg')).toContainText('44842');
    // P86 — the saved figures render as "already on your return".
    await expect(page.getByTestId('caploss-saved')).toContainText('long-term 44842');
  });

  test('a K-1 saves as one manual source of registered concepts', async ({ page }) => {
    await page.goto('/data');
    await page.getByTestId('field-k1_id').fill('asap-llc');
    const k1 = page.getByTestId('form-k1');
    await k1.getByTestId('field-box1').fill('1200');
    await k1.getByTestId('field-basis_opening').fill('5000');
    await page.getByTestId('save-k1').click();
    await page.waitForURL(/\/data\?msg=/);
    await expect(page.getByTestId('data-msg')).toContainText('Saved');
    // The completion card must NOT appear: basis and participation are in.
    await expect(page.getByTestId('detected-k1-asap-llc')).toHaveCount(0);
  });

  test('a free-form concept id is refused by the registry, not saved', async ({ page }) => {
    await page.goto('/data');
    await page.getByTestId('field-k1_id').fill('bad id with spaces');
    const k1 = page.getByTestId('form-k1');
    await k1.getByTestId('field-box1').fill('10');
    await page.getByTestId('save-k1').click();
    await page.waitForURL(/\/data\?msg=/);
    await expect(page.getByTestId('data-msg')).toContainText('short id');
  });
});

test.describe('Year-Round, Mark Filed, year close, Audit Readiness', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('capture is append-only with immutable timestamps; a generic purpose is flagged', async ({ page }) => {
    await page.goto('/year-round');
    await page.getByTestId('mileage-miles').fill('34');
    await page.getByTestId('mileage-purpose').fill('misc'); // generic → incomplete
    await page.getByTestId('mileage-add').click();
    await page.waitForURL(/\/year-round/);
    const list = page.getByTestId('mileage-list');
    await expect(list.getByTestId('substantiation-badge')).toContainText('incomplete');
    await expect(list.getByTestId('completeness-prompt')).toBeVisible();
    // Amend with a specific purpose → NEW version, history retained.
    await list.locator('[data-testid^="amend-purpose-"]').fill('Client visit: Acme Corp quarterly books review');
    await list.locator('[data-testid^="amend-save-"]').click();
    await page.waitForURL(/\/year-round/);
    await expect(page.getByTestId('mileage-list').getByTestId('substantiation-badge')).toContainText('complete');
    await expect(page.getByTestId('mileage-list').getByTestId('history-note')).toContainText('2 versions retained');
  });

  test('estimated-tax: prior-year anchor + a payment render the two-method table', async ({ page }) => {
    await page.goto('/year-round');
    await page.getByTestId('prior-year-tax').fill('12000');
    await page.getByTestId('prior-year-save').click();
    await page.waitForURL(/\/year-round/);
    await page.getByTestId('payment-amount').fill('3300');
    await page.getByTestId('payment-add').click();
    await page.waitForURL(/\/year-round/);
    await expect(page.getByTestId('esttax-table')).toBeVisible();
    await expect(page.getByTestId('esttax-q1')).toContainText('$');
  });

  test('year close is REFUSED before a filed return exists', async ({ page }) => {
    await page.goto('/year-round');
    await page.getByTestId('close-year').click();
    await page.waitForURL(/\/year-round\?msg=/);
    await expect(page.getByTestId('yr-msg')).toContainText('requires a FILED return');
  });

  test('Mark as Filed freezes the filed record on File It', async ({ page }) => {
    await page.goto('/file-it');
    // The journey suite locked a package; mark it filed.
    await page.getByTestId('markfiled').click();
    await page.waitForURL(/\/file-it\?msg=/);
    await expect(page.getByTestId('filed-banner')).toContainText('Marked FILED');
    await expect(page.getByTestId('filed-banner')).toContainText('package v1');
  });

  test('year close now rolls registers into next-year openings', async ({ page }) => {
    await page.goto('/year-round');
    await page.getByTestId('close-year').click();
    await page.waitForURL(/\/year-round\?msg=/);
    await expect(page.getByTestId('yr-msg')).toContainText('Year closed');
  });

  test('Audit Readiness lists gate-5 items or a clean bill, and the Defense File downloads', async ({ page }) => {
    await page.goto('/risk');
    await expect(page.getByTestId('risk-overview')).toBeVisible();
    await expect(page.getByTestId('ack-copy')).toContainText('§7602');
    await expect(page.getByTestId('defense-download')).toBeVisible();
    const res = await page.request.get('/api/defense');
    expect(res.status()).toBe(200);
    const file = await res.json();
    expect(file.sections?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(file)).toContain('NEUTRAL GATE LOG');
  });
});
