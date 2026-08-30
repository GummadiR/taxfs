/**
 * Subject: the whole-return journey against the PRODUCTION build in local
 * operator mode over the real migrations + RLS: create a workspace, save
 * filing choices, add documents, confirm every value, run the gates, see
 * the board, lock a package. Skips loudly when no database is available
 * (CI always provides one).
 */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const HAS_DB = Boolean(process.env.TAXFS_TEST_DATABASE_URL);

test.describe('return journey (local operator, real database)', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — journey needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('create a workspace and save filing choices', async ({ page }) => {
    await page.goto('/workspaces');
    await page.getByTestId('new-workspace-name').fill('Journey Family');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByTestId('whats-left')).toContainText('Journey Family');

    await page.goto('/get-started');
    await page.getByTestId('filing-status').selectOption('mfj');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/documents/);
  });

  test('add documents; values wait unconfirmed behind the review door', async ({ page }) => {
    await page.goto('/documents');
    await page.getByTestId('add-demo-w2').click();
    await expect(page).toHaveURL(/\/review/);
    await page.goto('/documents');
    await page.getByTestId('add-demo-1099int').click();

    await page.goto('/documents');
    await page.getByTestId('manual-concept').selectOption({ label: 'Federal estimated payments' });
    await page.getByTestId('manual-amount').fill('1000');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForURL(/\/review/);   // the action redirects once committed
    const rows = page.getByTestId('sourced-facts').locator('tr');
    await expect(rows).toHaveCount(5); // 3 W-2 boxes + 1 interest + 1 typed entry
    // The typed entry IS confirmed (typing is the confirmation); extracted
    // demo values are NOT until the operator says so.
    await expect(page.getByTestId('sourced-facts')).toContainText('unconfirmed');
  });

  test('confirm every value, run the gates, board goes green', async ({ page }) => {
    await page.goto('/review');
    // Each confirm is a server action that refreshes the page in place;
    // waiting for THAT button to detach is the commit signal (URL never
    // changes, so URL-waiting would race the action).
    const buttons = page.getByTestId('sourced-facts').getByRole('button', { name: 'Confirm' });
    const ids = await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    for (const id of ids) {
      if (!id) continue;
      await page.getByTestId(id).click();
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByTestId('sourced-facts')).not.toContainText('unconfirmed');

    await page.goto('/gates');
    await page.getByTestId('run-gates').click();
    await expect(page.getByTestId('gates-board')).toBeVisible();
    for (const gate of [0, 1, 2, 3, 4, 6]) {
      await expect(page.getByTestId(`gate-${gate}-FED`)).toHaveText(/pass|ack/);
      await expect(page.getByTestId(`gate-${gate}-IL`)).toHaveText(/pass|ack/);
    }
  });

  test('computed lines carry human labels, a plain-English summary, and a full drilldown', async ({ page }) => {
    await page.goto('/review');
    // Human labels, never raw concept ids (the id stays available as a tooltip).
    const fed = page.getByTestId('fed-lines');
    await expect(fed).toContainText('Adjusted gross income');
    await expect(fed).not.toContainText('fed.agi');
    await expect(page.getByTestId('review-summary')).toContainText('total income');
    // Every amount opens the lineage drawer (the ported TaxOS component):
    // human labels, a plain-English origin word, and the machine detail kept
    // behind "For your CPA" rather than shown as raw ids.
    await fed.locator('tr', { hasText: 'Adjusted gross income' }).getByRole('button').click();
    const drawer = page.getByTestId('lineage-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Where this number comes from');
    await expect(drawer).toContainText('Adjusted gross income');
    // The technical proof is present but collapsed, not dumped on the reader.
    await expect(drawer.getByTestId('lineage-technical')).toContainText('For your CPA');
    await drawer.getByTestId('lineage-technical').click();
    await expect(drawer.getByTestId('lineage-technical')).toContainText('round_half_up');
  });

  test('File It locks a package row', async ({ page }) => {
    await page.goto('/file-it');
    await page.getByTestId('build-package').click();
    await expect(page.getByTestId('package-list')).toContainText('v1');
    await expect(page.getByTestId('package-list')).toContainText('locked');
  });

  test('the downloaded 1040 carries the typed identity — filled in the BROWSER, never on the server', async ({ page }) => {
    // Synthetic identity only (repo rule): fake name, fake SSN with dashes.
    await page.goto('/file-it');
    await page.getByTestId('identity-passphrase').fill('journey-pass-1');
    await page.getByTestId('taxpayer-first').fill('Testy');
    await page.getByTestId('taxpayer-last').fill('Journey');
    await page.getByTestId('taxpayer-ssn').fill('123-45-6789');
    await page.getByTestId('identity-save').click();
    await expect(page.getByTestId('identity-status')).toContainText('Saved');

    const waiting = page.waitForEvent('download');
    await page.getByTestId('download-1040').click();
    const download = await waiting;
    const bytes = await readFile((await download.path())!);
    const doc = await PDFDocument.load(new Uint8Array(bytes));
    const form = doc.getForm();
    // The P80-verified 1040 Step-1 field names; SSN lands as bare digits (P92 comb field).
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_14[0]').getText()).toBe('Testy');
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_15[0]').getText()).toBe('Journey');
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_16[0]').getText()).toBe('123456789');

    // And the identity-blank download really is blank — the server never saw a name.
    const waitingBlank = page.waitForEvent('download');
    await page.getByTestId('download-blank-1040').click();
    const blankBytes = await readFile((await (await waitingBlank).path())!);
    const blankForm = (await PDFDocument.load(new Uint8Array(blankBytes))).getForm();
    expect(blankForm.getTextField('topmostSubform[0].Page1[0].f1_16[0]').getText() ?? '').toBe('');
  });
});

test.describe('client-side identity (§5) — print-package proof', () => {
  test.skip(!HAS_DB, 'needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  const SSN = '123-45-6789'; // synthetic, typed WITH dashes (the P92 shape)

  test('identity fills the downloaded 1040 IN THE BROWSER — comb digits, name, ticks', async ({ page }) => {
    await page.goto('/file-it');
    await page.getByTestId('taxpayer-first').fill('Testfirst');
    await page.getByTestId('taxpayer-last').fill('Testcase');
    await page.getByTestId('taxpayer-ssn').fill(SSN);
    await page.getByTestId('identity-address').fill('1 Synthetic Way');
    await page.getByTestId('identity-city').fill('Springfield');
    await page.getByTestId('identity-passphrase').fill('correct-horse-battery');
    await page.getByTestId('identity-save').click();
    await expect(page.getByTestId('identity-status')).toContainText('Saved');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-1040').click();
    const download = await downloadPromise;
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), { ignoreEncryption: true });
    const form = doc.getForm();
    // Byte-level: the browser-filled bytes carry the identity in the exact fields.
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_16[0]').getText()).toBe('123456789');
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_14[0]').getText()).toBe('Testfirst');
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_15[0]').getText()).toBe('Testcase');
  });

  test('the SERVER-SERVED artifact is identity-blank (the split holds)', async ({ page }) => {
    await page.goto('/file-it');
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-blank-1040').click();
    const download = await downloadPromise;
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)), { ignoreEncryption: true });
    const form = doc.getForm();
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_16[0]').getText() ?? '').toBe('');
    expect(form.getTextField('topmostSubform[0].Page1[0].f1_14[0]').getText() ?? '').toBe('');
    // The money lines ARE there — blank identity, real return. The paper
    // format is the plain kernel string (whole dollars, no thousands comma).
    const texts = form
      .getFields()
      .map((field) => (field as { getText?: () => string | undefined }).getText?.() ?? '');
    expect(texts.some((t) => t === '50000')).toBe(true);
  });

  test('the vault survives a reload behind the passphrase; a wrong one is refused', async ({ page }) => {
    // Each Playwright test is a FRESH browser context (fresh IndexedDB) —
    // which itself proves the vault is per-browser, never server-side. So
    // this test saves, reloads the page in the SAME context, and unlocks.
    await page.goto('/file-it');
    await page.getByTestId('taxpayer-first').fill('Testfirst');
    await page.getByTestId('taxpayer-ssn').fill(SSN);
    await page.getByTestId('identity-passphrase').fill('correct-horse-battery');
    await page.getByTestId('identity-save').click();
    await expect(page.getByTestId('identity-status')).toContainText('Saved');

    await page.reload();
    await expect(page.getByTestId('taxpayer-ssn')).toHaveValue(''); // gone from the DOM until unlocked
    await page.getByTestId('identity-passphrase').fill('wrong-passphrase');
    await page.getByTestId('identity-load').click();
    await expect(page.getByTestId('identity-status')).toContainText('Wrong passphrase');
    await expect(page.getByTestId('taxpayer-ssn')).toHaveValue('');

    await page.getByTestId('identity-passphrase').fill('correct-horse-battery');
    await page.getByTestId('identity-load').click();
    await expect(page.getByTestId('identity-status')).toContainText('Loaded');
    await expect(page.getByTestId('taxpayer-ssn')).toHaveValue(SSN);
    await expect(page.getByTestId('taxpayer-first')).toHaveValue('Testfirst');
  });
});

test.describe('G9 — no identity ever reaches the server', () => {
  test.skip(!HAS_DB, 'needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('an SSN-shaped value in a server input is REFUSED', async ({ page }) => {
    await page.goto('/workspaces');
    await page.getByTestId('new-workspace-name').fill('Family 123-45-6789');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByTestId('workspace-error')).toContainText('never stores identity');
  });

  test('after the whole journey, NO table anywhere contains the synthetic SSN', async () => {
    const pg = (await import('pg')).default;
    const url = new URL(process.env.TAXFS_TEST_DATABASE_URL!);
    url.pathname = '/taxfs_e2e';
    const admin = new pg.Client({ connectionString: url.href });
    await admin.connect();
    try {
      const cols = await admin.query(`
        select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('public', 'storage')
          and data_type in ('text', 'character varying', 'jsonb', 'json')`);
      const needles = ['123-45-6789', '123456789', '987-65-4321', 'Testfirst', 'Testcase'];
      const hits: string[] = [];
      for (const c of cols.rows) {
        for (const needle of needles) {
          const r = await admin.query(
            `select count(*)::int as n from ${c.table_schema}.${c.table_name}
              where ${c.column_name}::text like '%' || $1 || '%'`,
            [needle],
          );
          if (r.rows[0].n > 0) hits.push(`${c.table_schema}.${c.table_name}.${c.column_name} contains ${needle}`);
        }
      }
      expect(hits).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

test.describe('tax history (§7.6)', () => {
  test.skip(!HAS_DB, 'needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('prior years sit beside the computed current year; no projection without a cited release', async ({ page }) => {
    await page.goto('/history');
    await page.getByTestId('history-demo').click();
    await expect(page.getByTestId('history-table')).toBeVisible();
    // The demo 2024 column and THIS return's computed column, side by side.
    await expect(page.getByTestId('history-table')).toContainText('2024');
    await expect(page.getByTestId('history-table')).toContainText('2025 (this return)');
    await expect(page.getByTestId('history-table')).toContainText('48,000'); // 2024 AGI (demo)
    await expect(page.getByTestId('history-table')).toContainText('51,200'); // 2025 total income: 50,000 wages + 1,200 interest
    // Charts render for populated lines; table stays primary.
    await expect(page.getByTestId('history-charts').locator('figure').first()).toBeVisible();
    // Projection honesty: no 2026 release on disk → the reason, never a guess.
    await expect(page.getByTestId('projection-note')).toContainText('never projects on guessed figures');
  });

  test('a typed prior-year line lands in the table', async ({ page }) => {
    await page.goto('/history');
    await page.getByTestId('history-year').selectOption('2023');
    await page.getByTestId('history-line').selectOption('agi');
    await page.getByTestId('history-value').fill('45000');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForURL(/\/history/);
    await expect(page.getByTestId('history-table')).toContainText('2023');
    await expect(page.getByTestId('history-table')).toContainText('45,000');
  });
});

test.describe('hardening & discovery surface (§7.7–7.8)', () => {
  test.skip(!HAS_DB, 'needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('the Discovery card asks about the W-2 box 12 W with no coverage entered', async ({ page }) => {
    await page.goto('/review');
    await expect(page.getByTestId('discovery-card')).toBeVisible();
    await expect(page.getByTestId('discovery-card')).toContainText('box 12 code W');
    await expect(page.getByTestId('discovery-card')).toContainText('?');
  });

  test('the agent-trace viewer renders (empty until live calls)', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByTestId('traces-empty')).toBeVisible();
  });

  test('the owner can add a reviewer member; the roster shows it', async ({ page }) => {
    await page.goto('/workspaces');
    await page.getByTestId('member-uuid').fill('99999999-9999-4999-8999-999999999999');
    await page.getByTestId('member-role').selectOption('reviewer');
    await page.getByTestId('member-add').click();
    await page.waitForURL(/\/workspaces/);
    await expect(page.getByTestId('member-list')).toContainText('99999999-9999-4999-8999-999999999999');
    await expect(page.getByTestId('member-list')).toContainText('reviewer');
  });
});
