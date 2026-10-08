import { expect, test, type Page } from '@playwright/test';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => {
    if (/An error occurred in the <.+> component|Minified React error #\d+/.test(message.text())) errors.push(message.text());
  });
});
test.afterEach(({ page }) => { expect(pageErrors.get(page), 'No page errors or React crashes').toEqual([]); });

// Browser geometry/gesture regressions only. Native cursor, focus, tray and DPI need desktop QA.
for (const projectOnly of [false, true]) {
  test(`Island preview contains the collapsed capsule and keeps hover/focus (${projectOnly ? 'quiet' : 'session'})`, async ({ page }) => {
    const longLabel = 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8);
    await page.goto(`/harness.html?view=island&t=4&chrome=0&island-label=${encodeURIComponent(longLabel)}${projectOnly ? '&project-only=1' : ''}`);
    const island = page.locator('.island');
    await expect(island).toHaveAttribute('aria-expanded', 'false');
    // Stress the actual React data path, preserving ownership of the label's text node.
    const label = island.locator('.island__label');
    await expect(label).toHaveText(longLabel);
    const mountedLabel = await label.elementHandle();
    if (!mountedLabel) throw new Error('Collapsed label missing');
    const mountedText = await mountedLabel.evaluateHandle(el => el.lastChild);
    const closed = await island.boundingBox();
    if (!closed) throw new Error('Collapsed Island missing');
    expect(closed.width).toBeGreaterThanOrEqual(150);
    expect(closed.width).toBeLessThanOrEqual(340);
    expect(closed.height).toBe(34);
    expect(closed.y).toBe(10);
    await expect(island.locator('.island__character')).toHaveCSS('width', '28px');
    await expect(island.locator('.island__character')).toHaveCSS('height', '28px');
    await expect(island.locator('.mini-orb')).toHaveCSS('width', '14px');
    await island.hover();
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    expect(await mountedLabel.evaluate(el => el.isConnected)).toBe(true);
    expect(await mountedText.evaluate(node => node?.isConnected)).toBe(true);
    // The approved ZIP keeps row 1 visible in the preview; both DOM nodes must survive.
    await expect(label).toBeVisible();
    await expect.poll(async () => Math.round((await island.boundingBox())!.width)).toBe(340);
    // D hierarchy adds a project/agent row; disabled usage keeps the base preview compact.
    await expect.poll(async () => Math.round((await island.boundingBox())!.height)).toBe(144);
    const open = (await island.boundingBox())!;
    expect(open.x).toBeLessThanOrEqual(closed.x + 1);
    expect(open.y).toBeLessThanOrEqual(closed.y + 1);
    expect(open.x + open.width).toBeGreaterThanOrEqual(closed.x + closed.width - 1);
    expect(open.y + open.height).toBeGreaterThanOrEqual(closed.y + closed.height - 1);
    expect(open.y + open.height).toBeLessThanOrEqual(184);
    await page.mouse.move(open.x + 50, open.y + open.height - 15);
    await page.waitForTimeout(300);
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    await island.locator('.mini-orb:visible').first().click();
    await expect(page.locator('.expanded')).toHaveCount(0);
    await expect(page.locator('.mini')).toHaveCount(0);
    const full = island.getByRole('button', { name: 'Open window', exact: true });
    await full.focus();
    await page.mouse.move(0, 300);
    await page.waitForTimeout(300);
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(island).toHaveAttribute('aria-expanded', 'false');
    await expect(label).toBeVisible();
    await expect(label).toHaveText(longLabel);
    expect(await mountedLabel.evaluate(el => el.isConnected)).toBe(true);
    expect(await mountedText.evaluate(node => node?.isConnected)).toBe(true);
  });
}

test('quiet Island opens full view only from its explicit action', async ({ page }) => {
  await page.goto('/harness.html?view=island&project-only=1&t=4&chrome=0');
  const island = page.locator('.island');
  await island.hover();
  await expect(island.getByText('No agent active right now.', { exact: true })).toBeVisible();
  await island.getByRole('button', { name: 'Open window', exact: true }).click();
  await expect(page.locator('.expanded')).toBeVisible();
});
