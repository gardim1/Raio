import { expect, test } from '@playwright/test';

const warning = "Raio's hooks for this project are out of date — reconnect to capture PowerShell checks.";

test('outdated hooks reuse preview, Cancel and explicit Connect', async ({ page }) => {
  await page.goto('/harness.html?view=expanded&project-only=1&hooks=outdated&t=0&chrome=0');
  await expect(page.getByText('Demo fixture · not real agent activity')).toBeVisible();
  await expect(page.getByText(warning, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  const review = page.locator('.connect--review');
  await expect(review).toBeVisible();
  // Assert before clicking: Playwright's automatic click scrolling must not hide a below-fold regression.
  await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(review.locator('.connect__title')).toBeInViewport({ ratio: 1 });
  const widths = await review.locator('.connect__diff > div').evaluateAll((blocks) => blocks.map((block) => block.getBoundingClientRect().width));
  expect(widths.every((width) => width >= 200)).toBe(true);
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
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  await expect(page.locator('.status__label')).toHaveText('No session yet');
  await expect(page.getByText('Integration configured · waiting for the first Claude event', { exact: true })).toBeVisible();
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

for (const change of ['id', 'root'] as const) {
  test(`clears reconnect review when project ${change} changes and returns`, async ({ page }) => {
    await page.goto('/harness.html?view=expanded&project-only=1&t=0&chrome=0');
    await page.evaluate(async () => {
      const fixtureModule = '/tests/visual/fixtures/connection-switch.tsx';
      const { mountConnectionSwitchFixture } = await import(fixtureModule);
      mountConnectionSwitchFixture();
    });
    const fixture = page.locator('#connection-switch-fixture');
    await expect(fixture.getByText('Connection test fixture · no real settings')).toBeVisible();
    await fixture.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(fixture.locator('.connect--review')).toBeVisible();
    await fixture.getByRole('button', { name: `Change project ${change}`, exact: true }).click();
    await expect(fixture.locator('.connect--review')).toHaveCount(0);
    await fixture.getByRole('button', { name: 'Return project', exact: true }).click();
    await expect(fixture.locator('.connect--review')).toHaveCount(0);
    await fixture.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(fixture.locator('.connect--review')).toBeVisible();
  });
}
