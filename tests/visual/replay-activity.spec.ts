import { expect, test, type Page } from '@playwright/test';

const mount = async (page: Page, frozen: boolean) => {
  await page.goto(`/harness.html?view=expanded&chrome=0${frozen ? '&t=40' : ''}`);
  await page.evaluate(async () => {
    const modulePath = '/tests/visual/fixtures/replay-activity.tsx';
    const { mountReplayActivityFixture } = await import(modulePath);
    mountReplayActivityFixture();
  });
  const fixture = page.locator('#replay-activity-fixture');
  await expect(fixture.getByText('Replay activity fixture · no real telemetry', { exact: false })).toBeVisible();
  await fixture.getByRole('button', { name: 'View changes', exact: true }).click();
  return fixture;
};

test('completed stopped replay returns to live on resumed activity, not on a snapshot refresh', async ({ page }) => {
  const fixture = await mount(page, true);
  await expect(fixture.locator('.status__label')).toHaveText('Replay complete');
  await expect(fixture.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Refresh same activity', exact: true }).click();
  await expect(fixture.getByRole('button', { name: 'Close replay', exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Append live activity', exact: true }).click();
  await expect(fixture.getByRole('button', { name: 'Close replay', exact: true })).toHaveCount(0);
  await expect(fixture.locator('.status__label')).not.toHaveText(/Replay/);
});

test('new activity preserves playing and paused unfinished replays', async ({ page }) => {
  const fixture = await mount(page, false);
  await expect(fixture.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Append live activity', exact: true }).click();
  await expect(fixture.getByRole('button', { name: 'Close replay', exact: true })).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await expect(fixture.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Append live activity', exact: true }).click();
  await expect(fixture.getByRole('button', { name: 'Close replay', exact: true })).toBeVisible();
  await expect(fixture.locator('.status__label')).not.toHaveText('Replay complete');
});
