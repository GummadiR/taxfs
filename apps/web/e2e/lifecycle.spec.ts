/**
 * Subject: Reset and Delete against the PRODUCTION build over the real
 * migrations + RLS. This spec builds and destroys its OWN workspace so it
 * cannot disturb the journey's; the journey's workspace is the one that
 * proves the app works, and a wipe test that shared it would be a coin flip
 * on file ordering.
 *
 * The database-side refusals live in supabase/test/lifecycle.test.ts. What
 * is only checkable here is the operator's path: the typed confirmation
 * arming the button, the per-table report, and the workspace disappearing.
 */
import { test, expect } from '@playwright/test';

const HAS_DB = Boolean(process.env.TAXFS_TEST_DATABASE_URL);
const NAME = 'Wipe Test Workspace';

test.describe('reset and delete a workspace', () => {
  test.skip(!HAS_DB, 'TAXFS_TEST_DATABASE_URL not set — needs a database; CI always runs it');
  test.describe.configure({ mode: 'serial' });

  test('a workspace with data in it can be emptied, and reports what it removed', async ({ page }) => {
    await page.goto('/workspaces');
    await page.getByTestId('new-workspace-name').fill(NAME);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByTestId('whats-left')).toContainText(NAME);

    // Put something in it, so "emptied" is a claim with teeth.
    await page.goto('/get-started');
    await page.getByTestId('filing-status').selectOption('single');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/documents/);
    await page.getByTestId('add-demo-w2').click();
    await expect(page).toHaveURL(/\/review/);

    await page.goto('/workspaces');
    await page.getByTestId('danger-workspace').selectOption({ label: NAME });
    await page.getByTestId('danger-action').selectOption('reset');

    // The button stays disabled until the name is typed EXACTLY.
    await expect(page.getByTestId('danger-run')).toBeDisabled();
    await page.getByTestId('danger-confirm').fill(NAME.toLowerCase());
    await expect(page.getByTestId('danger-run')).toBeDisabled();
    await page.getByTestId('danger-confirm').fill(NAME);
    await expect(page.getByTestId('danger-run')).toBeEnabled();

    await page.getByTestId('danger-run').click();
    const report = page.getByTestId('danger-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('rows removed');
    await expect(report).toContainText('sources');
    await expect(report).toContainText('tax_facts');

    // The workspace itself survives a reset, emptied.
    await page.goto('/workspaces');
    await expect(page.getByTestId('workspace-list')).toContainText(NAME);
    await page.goto('/review');
    // The table always renders, and an empty one carries its own row, so
    // "no rows" would be the wrong assertion: assert the empty STATE.
    await expect(page.getByTestId('sourced-facts')).toContainText('Nothing entered yet.');
  });

  test('deleting removes the workspace from the list entirely', async ({ page }) => {
    await page.goto('/workspaces');
    await page.getByTestId('danger-workspace').selectOption({ label: NAME });
    await page.getByTestId('danger-action').selectOption('delete');
    await page.getByTestId('danger-confirm').fill(NAME);
    await page.getByTestId('danger-run').click();
    await expect(page.getByTestId('danger-report')).toContainText('Deleted');

    await page.goto('/workspaces');
    await expect(page.getByTestId('workspace-list')).not.toContainText(NAME);
  });

  test('a mistyped confirmation cannot reach the destructive path', async ({ page }) => {
    await page.goto('/workspaces');
    const zone = page.getByTestId('danger-zone');
    await expect(zone).toBeVisible();
    await page.getByTestId('danger-confirm').fill('definitely not the name');
    await expect(page.getByTestId('danger-run')).toBeDisabled();
  });
});
