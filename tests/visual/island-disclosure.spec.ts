import { expect, test } from '@playwright/test';

// Accessible-role queries complement the existing, unchanged geometry/hover spec.
for (const projectOnly of [false, true]) {
  test(`Island exposes a disclosure button and separate named preview (${projectOnly ? 'quiet' : 'session'})`, async ({ page }) => {
    await page.goto(`/harness.html?view=island&t=4&chrome=0${projectOnly ? '&project-only=1' : ''}`);
    const disclosure = page.getByRole('button', { name: /^Raio: / });
    await expect(page.getByRole('button', { name: /^Raio: /, expanded: false })).toHaveCount(1);
    await expect(disclosure.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Island preview', exact: true })).toHaveCount(0);
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
    const full = preview.getByRole('button', { name: 'Open full view', exact: true });
    await expect(full).toBeVisible();

    await disclosure.press('Enter');
    await disclosure.press('Space');
    await expect(page.locator('.expanded')).toHaveCount(0);
    await expect(page.locator('.mini')).toHaveCount(0);
    await full.focus();
    await page.mouse.move(0, 300);
    await page.waitForTimeout(300);
    await expect(preview).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Raio: /, expanded: false })).toHaveCount(1);
    await expect(preview).toHaveCount(0);
  });
}
