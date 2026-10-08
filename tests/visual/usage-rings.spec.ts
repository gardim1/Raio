import { expect, test, type Page } from '@playwright/test';
import type { CookieUsageFixtureControls } from './fixtures/cookie-usage';

const NOW = Date.UTC(2026, 9, 8, 12);
const mount = async (page: Page, usage: string) => {
  await page.addInitScript(now => { Date.now = () => now; }, NOW);
  await page.goto('/harness.html?view=expanded&project-only=1&t=4.15&chrome=0');
  await page.evaluate(async state => {
    const modulePath = '/tests/visual/fixtures/cookie-usage.tsx';
    const { mountCookieUsageFixture } = await import(modulePath);
    mountCookieUsageFixture({ usage: state });
  }, usage);
  const fixture = page.locator('#cookie-usage-fixture');
  await expect(fixture.locator('.expanded')).toBeVisible();
  return fixture;
};

test('Expanded orders rings, cookie and surface actions, with independent USED arcs and keyboard details', async ({ page }) => {
  const fixture = await mount(page, 'fresh');
  const actions = fixture.locator('.titlebar__actions');
  expect(await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Claude plan usage', 'Give Raio a cookie', 'Open Mini Player', 'Show as Island']);
  const button = actions.getByRole('button', { name: 'Claude plan usage', exact: true });
  const inner = button.locator('circle.usage-rings__fill[data-window="fiveHour"]');
  const outer = button.locator('circle.usage-rings__fill[data-window="sevenDay"]');
  await expect(inner).toHaveAttribute('r', '10'); await expect(inner).toHaveAttribute('stroke-dasharray', '24 100');
  await expect(outer).toHaveAttribute('r', '16'); await expect(outer).toHaveAttribute('stroke-dasharray', '68 100');
  expect(await inner.evaluate(element => getComputedStyle(element).stroke)).not.toBe(await outer.evaluate(element => getComputedStyle(element).stroke));
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.focus();
  const details = fixture.getByRole('region', { name: 'Claude plan usage details', exact: true });
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toContainText('5-hour limit · 24% used · resets');
  await expect(details).toContainText('Weekly limit · 68% used · resets');
  await expect(details).toContainText('Updated 2 minutes ago');
  await expect(details).toContainText('Source Claude Code session demo1234');
  await expect(button).toHaveAttribute('aria-controls', await details.getAttribute('id') ?? '');
  await page.keyboard.press('Tab'); await expect(details).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(details).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('hover can reach the details and click can reopen them after Escape', async ({ page }) => {
  const fixture = await mount(page, 'fresh');
  const button = fixture.getByRole('button', { name: 'Claude plan usage', exact: true });
  await button.hover();
  const details = fixture.getByRole('region', { name: 'Claude plan usage details', exact: true });
  await details.hover(); await expect(details).toBeVisible();
  const rect = await details.boundingBox();
  const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height);
  await details.focus(); await page.keyboard.press('Escape');
  await button.click(); await expect(button).toHaveAttribute('aria-expanded', 'true');
});

test('bridge notifications replace the reading; stale, missing and expired are never a zero quota', async ({ page }) => {
  const fixture = await mount(page, 'fresh');
  const set = (id: string) => page.evaluate(value => (window as Window & CookieUsageFixtureControls).__usageState(value), id);
  await set('stale');
  expect(await fixture.locator('.usage-rings__svg').evaluate(element => getComputedStyle(element).opacity)).toBe('0.4');
  await fixture.getByRole('button', { name: 'Claude plan usage', exact: true }).focus();
  await expect(fixture.locator('.usage-details')).toContainText('Stale reading');
  await set('missing');
  await expect(fixture.locator('[data-window="fiveHour"][data-kind="missing"]')).toHaveCount(1);
  await expect(fixture.locator('circle.usage-rings__fill[data-window="fiveHour"]')).toHaveCount(0);
  await expect(fixture.locator('circle.usage-rings__fill[data-window="sevenDay"]')).toHaveCount(1);
  await expect(fixture.locator('.usage-details')).toContainText('5-hour limit · — · not reported');
  await set('expired');
  await expect(fixture.locator('[data-window="sevenDay"][data-kind="expired"]')).toHaveCount(1);
  await expect(fixture.locator('circle.usage-rings__fill[data-window="sevenDay"]')).toHaveCount(0);
  await expect(fixture.locator('.usage-details')).toContainText('reset passed; waiting for a new reading');
  await set('disabled');
  await expect(fixture.getByRole('button', { name: 'Claude plan usage', exact: true })).toHaveCount(0);
  await expect(fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true })).toBeVisible();
});

for (const [state, reason] of [['waiting', 'Waiting for Claude Code to report plan limits'], ['incompatible', 'existing user status line'], ['error', 'snapshot could not be read']] as const) {
  test(`${state} explains Usage unavailable in Expanded`, async ({ page }) => {
    const fixture = await mount(page, state);
    const button = fixture.getByRole('button', { name: 'Claude plan usage', exact: true });
    await expect(button).toContainText('Usage unavailable');
    await expect(button.locator('circle.usage-rings__fill')).toHaveCount(0);
    await button.click();
    await expect(fixture.locator('.usage-details')).toContainText(reason);
  });
}

test('every labelled DEMO state and compact keyboard details are available on the bench', async ({ page }) => {
  await page.goto('/harness.html?view=character&capture=1&chrome=0');
  const panel = page.getByRole('region', { name: 'DEMO Claude plan usage', exact: true });
  await expect(panel).toContainText('These are not your account readings');
  for (const state of ['fresh', 'stale', 'missing', 'expired', 'waiting', 'incompatible', 'error', 'disabled']) {
    await expect(panel.locator(`[data-usage-demo="${state}"]`)).toContainText('DEMO');
  }
  const fresh = panel.locator('[data-usage-demo="fresh"]');
  await fresh.getByRole('button', { name: 'Claude plan usage', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(fresh.getByRole('region', { name: 'Claude plan usage details', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(fresh.getByRole('button', { name: 'Claude plan usage', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('usage states and Expanded details visual review (new goldens required)', async ({ page }) => {
  const fixture = await mount(page, 'fresh');
  await fixture.getByRole('button', { name: 'Claude plan usage', exact: true }).focus();
  await page.evaluate(() => document.fonts.ready);
  await expect(fixture.locator('.expanded')).toHaveScreenshot('usage-expanded-details.png');
  await page.goto('/harness.html?view=character&capture=1&chrome=0');
  await page.evaluate(() => document.fonts.ready);
  const panel = page.getByRole('region', { name: 'DEMO Claude plan usage', exact: true });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveScreenshot('usage-demo-states.png');
});
