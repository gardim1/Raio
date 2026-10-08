import { expect, test } from '@playwright/test';

// Browser geometry/gesture regressions only. Native cursor, focus, tray and DPI need desktop QA.
for (const projectOnly of [false, true]) {
  test(`Island preview contains the collapsed capsule and keeps hover/focus (${projectOnly ? 'quiet' : 'session'})`, async ({ page }) => {
    await page.goto(`/harness.html?view=island&t=4&chrome=0${projectOnly ? '&project-only=1' : ''}`);
    const island = page.locator('.island');
    await expect(island).toHaveAttribute('aria-expanded', 'false');
    // Stress the existing label element with a 60+ character name without changing fixture sources.
    await island.locator('.island__label').evaluate(el => { el.textContent = 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8); });
    const closed = await island.boundingBox();
    if (!closed) throw new Error('Collapsed Island missing');
    await expect(island.locator('.mini-orb')).toHaveCSS('width', '14px');
    await island.hover();
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => Math.round((await island.boundingBox())!.width)).toBe(384);
    const open = (await island.boundingBox())!;
    expect(open.x).toBeLessThanOrEqual(closed.x + 1);
    expect(open.y).toBeLessThanOrEqual(closed.y + 1);
    expect(open.x + open.width).toBeGreaterThanOrEqual(closed.x + closed.width - 1);
    expect(open.y + open.height).toBeGreaterThanOrEqual(closed.y + closed.height - 1);
    expect(open.y + open.height).toBeLessThanOrEqual(184);
    await page.mouse.move(open.x + 50, open.y + open.height - 15);
    await page.waitForTimeout(300);
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    await island.locator('.mini-orb').first().click();
    await expect(page.locator('.expanded')).toHaveCount(0);
    await expect(page.locator('.mini')).toHaveCount(0);
    const full = island.getByRole('button', { name: 'Open full view', exact: true });
    await full.focus();
    await page.mouse.move(0, 300);
    await page.waitForTimeout(300);
    await expect(island).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(island).toHaveAttribute('aria-expanded', 'false');
  });
}

test('quiet Island opens full view only from its explicit action', async ({ page }) => {
  await page.goto('/harness.html?view=island&project-only=1&t=4&chrome=0');
  const island = page.locator('.island');
  await island.hover();
  await expect(island.getByText('Waiting for activity', { exact: true })).toBeVisible();
  await island.getByRole('button', { name: 'Open full view', exact: true }).click();
  await expect(page.locator('.expanded')).toBeVisible();
});
