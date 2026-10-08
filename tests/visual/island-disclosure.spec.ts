import { expect, test } from '@playwright/test';

// Accessible-role queries complement the geometry/hover spec.
for (const projectOnly of [false, true]) {
  test(`Island exposes a disclosure button and separate named preview (${projectOnly ? 'quiet' : 'session'})`, async ({ page }) => {
    await page.goto(`/harness.html?view=island&t=4&chrome=0${projectOnly ? '&project-only=1' : ''}`);
    const disclosure = page.getByRole('button', { name: /^Raio: / });
    await expect(page.getByRole('button', { name: /^Raio: /, expanded: false })).toHaveCount(1);
    await expect(disclosure.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Island preview', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Give Raio a cookie', exact: true })).toHaveCount(0);
    await expect(page.locator('button.island__cookie')).toHaveCount(0);
    const controlled = await disclosure.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();

    await disclosure.focus();
    await expect(page.getByRole('button', { name: /^Raio: /, expanded: true })).toHaveCount(1);
    const preview = page.getByRole('group', { name: 'Island preview', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('id', controlled!);
    await expect(disclosure).toBeFocused(); // The same button survives the geometry change.
    await expect(disclosure.getByRole('group')).toHaveCount(0);
    await expect(preview.getByRole('button', { name: 'Open Mini Player', exact: true })).toBeVisible();
    const full = preview.getByRole('button', { name: 'Open window', exact: true });
    await expect(full).toBeVisible();
    const cookie = preview.getByRole('button', { name: 'Give Raio a cookie', exact: true });
    await expect(cookie).toBeVisible();
    await expect(cookie).toHaveAttribute('title', 'Give Raio a cookie');
    await expect(cookie).toHaveCSS('width', '28px');
    await expect(cookie).toHaveCSS('height', '28px');
    await expect(cookie).toHaveCSS('border-radius', '50%');
    await expect.poll(async () => Math.round((await page.locator('.island').boundingBox())!.width)).toBe(340);
    await expect.poll(async () => Math.round((await page.locator('.island').boundingBox())!.height)).toBe(124);
    const capsule = (await page.locator('.island').boundingBox())!;
    for (const action of [preview.getByRole('button', { name: 'Open Mini Player', exact: true }), full, cookie]) {
      const box = (await action.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(capsule.x);
      expect(box.x + box.width).toBeLessThanOrEqual(capsule.x + capsule.width);
      expect(box.y + box.height).toBeLessThanOrEqual(capsule.y + capsule.height);
    }

    await disclosure.press('Enter');
    await disclosure.press('Space');
    await expect(page.locator('.expanded')).toHaveCount(0);
    await expect(page.locator('.mini')).toHaveCount(0);
    // Third action is reachable by keyboard; body gestures must retain the existing keyboard focus.
    await disclosure.press('Tab');
    await expect(preview.getByRole('button', { name: 'Open Mini Player', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(full).toBeFocused();
    await page.keyboard.press('Tab'); await expect(cookie).toBeFocused();
    await cookie.press('Enter');
    const character = page.locator('.island .mini-orb');
    await character.click(); await character.click(); await character.dblclick();
    await expect(cookie).toBeFocused();
    await expect(page.locator('.island')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.expanded')).toHaveCount(0); await expect(page.locator('.mini')).toHaveCount(0);
    await cookie.press('Escape');
    await expect(disclosure).toBeFocused();
    await expect(page.locator('button.island__cookie')).toHaveCount(0);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.press('Enter');
    await expect(preview).toBeVisible();
    await full.focus();
    await page.mouse.move(0, 300);
    await page.waitForTimeout(300);
    await expect(preview).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Raio: /, expanded: false })).toHaveCount(1);
    await expect(preview).toHaveCount(0);
    await expect(page.locator('button.island__cookie')).toHaveCount(0);
  });
}
