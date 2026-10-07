import { expect, test } from '@playwright/test';

const warning = "Raio's hooks for this project are out of date — reconnect to capture PowerShell checks.";

test('outdated hooks reuse preview, Cancel and explicit Connect', async ({ page }) => {
  await page.goto('/harness.html?view=expanded&project-only=1&hooks=outdated&t=0&chrome=0');
  await expect(page.getByText('Demo fixture · not real agent activity')).toBeVisible();
  await expect(page.getByText(warning, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const review = page.locator('.connect--review');
  await expect(review).toBeVisible();
  await expect(review.locator('.connect__diff > div').first()).toContainText('Bash');
  await expect(review.locator('.connect__diff > div').last()).toContainText('Bash|PowerShell');
  await expect(page.getByText(warning, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText(warning, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(review).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText(warning, { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  await expect(page.getByText('Connected to', { exact: false })).toBeVisible();
});

for (const state of ['current', 'unknown'] as const) {
  test(`no reconnect warning for ${state}`, async ({ page }) => {
    await page.goto(`/harness.html?view=expanded&project-only=1&hooks=${state}&t=0&chrome=0`);
    await expect(page.getByText('Demo fixture · not real agent activity')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await expect(page.getByText(warning, { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  });
}
