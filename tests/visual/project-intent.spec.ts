import { expect, test, type Page } from '@playwright/test';

const mount = async (page: Page, options: { connected?: boolean; startupRoot?: string; holdChosenPreview?: boolean } = {}) => {
  await page.goto('/harness.html?view=expanded&chrome=0&t=0');
  await page.evaluate(async (options) => {
    const modulePath = '/tests/visual/fixtures/project-intent.tsx';
    const { mountProjectIntentFixture } = await import(modulePath);
    mountProjectIntentFixture(options);
  }, options);
  const fixture = page.locator('#project-intent-fixture');
  await expect(fixture.getByText('Folder intent fixture · no real settings', { exact: false })).toBeVisible();
  return fixture;
};

test('startup folder intent previews the map and diff; Cancel and folder choice keep Connect mandatory', async ({ page }) => {
  const fixture = await mount(page, { startupRoot: 'C:/fixture/new' });
  const review = fixture.locator('.connect--review');
  await expect(fixture.getByRole('img', { name: 'Project architecture map' })).toBeVisible();
  await expect(fixture.getByText('new · No session yet', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
  await review.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(fixture.getByLabel('Settings writes')).toHaveText('1');
  await expect(fixture.getByText('No session recorded yet', { exact: true })).toBeVisible();
});

test('normalized connected intent selects the existing project without reconnecting', async ({ page }) => {
  const fixture = await mount(page, { connected: true });
  await fixture.getByRole('button', { name: 'Intent for connected folder', exact: true }).click();
  await expect(fixture.locator('.titlebar__project')).toHaveText('Fixture A');
  await expect(fixture.locator('.connect--review')).toHaveCount(0);
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
  await expect(fixture.getByText('No session recorded yet', { exact: true })).toBeVisible();
});

test('missing preview-map command shows unavailability alongside the mandatory settings review', async ({ page }) => {
  const fixture = await mount(page);
  await fixture.getByRole('button', { name: 'Make map unavailable', exact: true }).click();
  await fixture.getByRole('button', { name: 'Intent for new folder', exact: true }).click();
  const review = fixture.locator('.connect--review');
  await expect(fixture.getByText('Map unavailable for this folder', { exact: true })).toBeVisible();
  await expect(fixture.getByRole('img', { name: 'Project architecture map' })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
});

test('a late cancelled folder preview cannot overwrite the newer intent', async ({ page }) => {
  const fixture = await mount(page, { startupRoot: 'C:/fixture/slow' });
  await expect(fixture.getByText('Loading settings preview…', { exact: true })).toBeVisible();
  await fixture.getByRole('button', { name: 'Intent for new folder', exact: true }).click();
  await expect(fixture.locator('.connect__body code')).toHaveText('C:/fixture/new/.claude/settings.local.json');
  await fixture.getByRole('button', { name: 'Resolve old preview', exact: true }).click();
  await expect(fixture.locator('.connect__body code')).toHaveText('C:/fixture/new/.claude/settings.local.json');
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
});

test('an unconnected folder intent keeps Expanded chrome during review and returns to the selected project on Cancel', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  const fixture = await mount(page, { connected: true });
  await expect(fixture.locator('.titlebar__project')).toHaveText('Fixture A');
  await fixture.getByRole('button', { name: 'Intent for new folder', exact: true }).click();
  await expect(fixture.locator('.expanded .titlebar')).toBeVisible();
  await expect(fixture.locator('.titlebar__project')).toHaveText('new');
  await expect(fixture.locator('.titlebar__task')).toContainText('Review connection');
  await expect(fixture.locator('.connect--review')).toBeVisible();
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
  const review = fixture.locator('.connect--review');
  await review.getByRole('button', { name: 'Connect', exact: true }).scrollIntoViewIfNeeded();
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(fixture.locator('.titlebar')).toBeInViewport({ ratio: 1 });
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fixture.locator('.titlebar__project')).toHaveText('Fixture A');
  await expect(fixture.locator('.connect--review')).toHaveCount(0);
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
});

test('a chosen folder pending across Activity hide/show recovers its settings and map without connecting', async ({ page }) => {
  const fixture = await mount(page, { holdChosenPreview: true });
  await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
  await expect(fixture.getByText('Loading settings preview…', { exact: true })).toBeVisible();
  await expect(fixture.getByText('Mapping project…', { exact: true })).toBeVisible();
  const path = '/tests/visual/fixtures/project-intent.tsx';
  await page.evaluate(async path => { (await import(path)).setVisible(false); }, path);
  await expect(fixture.locator('.connect--review')).toBeHidden();
  await page.waitForTimeout(100);
  await page.evaluate(async path => { (await import(path)).resolveChosenPreview(); }, path);
  await page.evaluate(async path => { (await import(path)).setVisible(true); }, path);
  const review = fixture.locator('.connect--review');
  await expect(review.locator('.connect__body code')).toHaveText('C:/fixture/new/.claude/settings.local.json');
  await expect(fixture.getByRole('img', { name: 'Project architecture map' })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(fixture.getByLabel('Settings writes')).toHaveText('0');
});
