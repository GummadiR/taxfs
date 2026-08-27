/**
 * Subject: the whole-return journey against the PRODUCTION build in local
 * operator mode over the real migrations + RLS: create a workspace, save
 * filing choices, add documents, confirm every value, run the gates, see
 * the board, lock a package. Skips loudly when no database is available
 * (CI always provides one).
 */
import { test, expect } from '@playwright/test';

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

  test('computed lines carry a full drilldown', async ({ page }) => {
    await page.goto('/review');
    const derived = page.getByTestId('derived-facts');
    await expect(derived).toContainText('fed.agi');
    await page.getByRole('link', { name: 'drilldown' }).first().click();
    await expect(page.getByTestId('lineage-drawer')).toBeVisible();
    await expect(page.getByTestId('lineage-drawer')).toContainText('round_half_up');
  });

  test('File It locks a package row', async ({ page }) => {
    await page.goto('/file-it');
    await page.getByTestId('build-package').click();
    await expect(page.getByTestId('package-list')).toContainText('v1');
    await expect(page.getByTestId('package-list')).toContainText('locked');
  });
});
