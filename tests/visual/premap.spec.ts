import { expect, test } from '@playwright/test';

/** Connected-project state, separately labelled fixture data; no session or replay has been created. */
for (const view of ['expanded', 'mini', 'island'] as const) {
  test(`premap-${view}`, async ({ page }) => {
    await page.goto(`/harness.html?view=${view}&project-only=1&t=0&chrome=0`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    await expect(page.getByText('Demo fixture · not real agent activity')).toBeVisible();
    await expect(page.getByRole('button', { name: 'View changes' })).toHaveCount(0);
    await expect(page.getByText('Session started', { exact: false })).toHaveCount(0);
    if (view === 'island') {
      await expect(page.getByText('Connected · quiet', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('img', { name: 'Project architecture map' })).toBeVisible();
      await expect(page.locator(view === 'expanded' ? '.status__label' : '.mini__state').filter({ hasText: view === 'mini' ? 'Connected · quiet' : 'No session yet' })).toBeVisible();
      await expect(page.locator('.arch-node')).not.toHaveCount(0);
    }
    await expect(page).toHaveScreenshot(`premap-${view}.png`);
  });
}
