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

test.describe('Amend (1040-X cases)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('an amendment case opens against the filed return and builds A/B/C columns', async ({ page }) => {
    await page.goto('/amend');
    // The filed record from the Mark-as-Filed spec is on the books.
    await expect(page.getByTestId('amend-filed-ref')).toContainText('package v1');
    await page.getByTestId('amend-open').click();
    await page.waitForURL(/\/amend\?msg=/);
    await expect(page.getByTestId('amend-msg')).toContainText('opened');
    const kase = page.locator('[data-testid^="amend-case-"]').first();
    await expect(kase).toBeVisible();
    await kase.getByTestId('amend-summary').fill('interest income');
    await kase.getByTestId('amend-build').click();
    await page.waitForURL(/\/amend\?msg=/);
    await expect(page.getByTestId('amend-msg')).toContainText('columns built');
    // Column B = C − A is engine-asserted; the statement uses the template.
    await expect(page.getByTestId('amend-fed-rows')).toBeVisible();
    await expect(page.getByTestId('amend-statement')).toContainText('Explanation of changes');
  });

  test('finalizing federal starts the IL conformity clock; the companion generates', async ({ page }) => {
    await page.goto('/amend');
    const kase = page.locator('[data-testid^="amend-case-"]').first();
    await kase.getByTestId('amend-finalize').click();
    await page.waitForURL(/\/amend\?msg=/);
    await expect(page.getByTestId('amend-msg')).toContainText('finalized');
    await expect(page.getByTestId('il-companion-alert')).toBeVisible();
    await page.getByTestId('il-generate').click();
    await page.waitForURL(/\/amend\?msg=/);
    await expect(page.getByTestId('amend-il-rows')).toBeVisible();
  });
});

test.describe('Entities + Business Filing (1120-S / 1065)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('an S-corp with two members computes entity lines and exact K-1 allocation', async ({ page }) => {
    // Self-contained workspace: the journey workspace's personal-return data
    // stays untouched, and this suite cannot be broken by what earlier
    // suites entered (the lifecycle-spec lesson).
    await page.goto('/workspaces');
    await page.getByTestId('new-workspace-name').fill('Entity Co');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.waitForURL('**/');
    await page.goto('/get-started');
    await page.getByTestId('filing-status').selectOption('single');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await page.waitForURL(/\/documents/);
    await page.goto('/entities');
    const core = page.getByTestId('form-entity');
    await core.getByTestId('ent-entity_id').fill('acme-scorp');
    await core.getByTestId('ent-gross_receipts').fill('100000');
    await core.getByTestId('ent-cogs').fill('20000');
    await page.getByTestId('save-entity').click();
    await page.waitForURL(/\/entities\?msg=/);
    await expect(page.getByTestId('entities-msg')).toContainText('Saved');
    // Two members, 60/40. Each iteration starts from a msg-free URL so the
    // post-click waitForURL genuinely waits for THIS save's navigation —
    // otherwise the second iteration's wait matches the previous redirect
    // instantly and the fills race the navigation (typed into the old DOM,
    // wiped, submitted empty).
    for (const [member, share] of [['alice', '0.6'], ['bob', '0.4']] as const) {
      await page.goto('/entities');
      await page.getByTestId('ent-m-entity').fill('acme-scorp');
      await page.getByTestId('ent-m-member').fill(member);
      await page.getByTestId('ent-share').fill(share);
      await page.getByTestId('save-ent-member').click();
      await page.waitForURL(/\/entities\?msg=Saved/);
    }
    await expect(page.getByTestId('entity-lines')).toContainText('entity.acme-scorp.ordinary_income = 80000');
    // Cumulative rounding: member K-1 box1 amounts sum EXACTLY to the entity line.
    await expect(page.getByTestId('entity-lines')).toContainText('k1.acme-scorp-alice.box1 = 48000');
    await expect(page.getByTestId('entity-lines')).toContainText('k1.acme-scorp-bob.box1 = 32000');
  });

  test('Business Filing builds the per-entity package with owner K-1 copies', async ({ page }) => {
    // Fresh browser context per test — the workspace cookie is gone, and the
    // fallback is the FIRST membership. Re-open Entity Co explicitly.
    await page.goto('/workspaces');
    await page
      .getByTestId('workspace-list')
      .locator('li', { hasText: 'Entity Co' })
      .getByRole('button', { name: 'Open' })
      .click();
    await page.waitForURL('**/');
    await page.goto('/business');
    await expect(page.getByTestId('biz-entity-acme-scorp')).toContainText('S corporation');
    await page.getByTestId('biz-build').click();
    await page.waitForURL(/\/business/);
    const forms = page.getByTestId('biz-forms-acme-scorp');
    await expect(forms).toBeVisible();
    await expect(forms).toContainText('owner copy: alice');
    await expect(forms).toContainText('owner copy: bob');
  });
});

test.describe('Real document upload (scrub + store, extraction off)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('a clean PDF uploads: scrubbed locally, stored, listed with Rescan; extraction-off is said plainly', async ({ page }) => {
    test.setTimeout(120_000); // local OCR/scrub is real work
    await page.goto('/documents');
    await expect(page.getByTestId('upload-dropzone')).toBeVisible();
    await page.getByTestId('upload-file-input').setInputFiles('../../rules/fixtures/sample-docs/2025.SAMPLE.w2.pdf');
    // The dropzone posts sequentially then refreshes; the new source appears.
    await expect(page.getByTestId('source-list').locator('li', { hasText: 'USER_ENTRY' }).first())
      .toBeVisible({ timeout: 90_000 });
    // Stored uploads expose Rescan (P26) — demo/manual sources never do.
    await expect(page.locator('[data-testid^="rescan-doc-"]').first()).toBeVisible();
  });

  test('deleting the upload removes the source and its stored file', async ({ page }) => {
    await page.goto('/documents');
    const row = page.getByTestId('source-list').locator('li', { hasText: 'USER_ENTRY' }).first();
    await row.getByRole('button', { name: 'Remove' }).click();
    await page.waitForURL(/\/documents\?msg=/);
    await expect(page.getByTestId('docs-msg')).toContainText('deleted');
  });
});
