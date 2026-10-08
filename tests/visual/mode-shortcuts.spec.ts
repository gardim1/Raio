import { expect, test } from '@playwright/test';

test('mode shortcuts switch Expanded to Mini to Island and back without confusing the pin toggle', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/harness.html?view=expanded&chrome=0&t=4');
  const expanded = page.locator('.expanded .titlebar');
  await expect(expanded.locator('.titlebar__dots')).toBeVisible();
  await expect(expanded.locator('.titlebar__caption')).toHaveCount(0);
  await expanded.getByRole('button', { name: 'Open Mini Player', exact: true }).click();
  const mini = page.locator('.mini__head');
  const pin = mini.getByRole('button', { name: 'Stop keeping on top', exact: true });
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  await expect(mini.getByRole('button', { name: 'Keep on top', exact: true })).toBeVisible();
  await mini.getByRole('button', { name: 'Show as Island', exact: true }).click();
  await page.locator('.island').hover();
  const openMini = page.locator('.island').getByRole('button', { name: 'Open Mini Player', exact: true });
  await expect(openMini).toHaveAttribute('title', 'Open Mini Player');
  await openMini.click();
  await expect(mini.getByRole('button', { name: 'Keep on top', exact: true })).toBeVisible();
  await mini.getByRole('button', { name: 'Open full view', exact: true }).click();
  await expect(expanded.getByRole('button', { name: 'Show as Island', exact: true })).toHaveAttribute('title', 'Show as Island');
});
