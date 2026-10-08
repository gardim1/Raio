import { expect, test } from '@playwright/test';

for (const state of ['project-only', 'session'] as const) {
  test(`mini gestures before and during telemetry: ${state}`, async ({ page }) => {
    await page.goto(`/harness.html?view=mini&t=4.15&chrome=0${state === 'project-only' ? '&project-only=1' : ''}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const mini = page.locator('.mini');
    const rect = () => mini.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    });
    const start = await rect();
    const header = await page.locator('.mini__project').boundingBox();
    if (!header) throw new Error('Mini header is not visible');
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + header.width / 2 - 80, header.y + header.height / 2 - 60, { steps: 4 });
    await page.mouse.up();
    await expect.poll(rect).toEqual({ ...start, x: start.x - 80, y: start.y - 60 });

    const moved = await rect();
    const grip = await page.locator('.mini__resize').boundingBox();
    if (!grip) throw new Error('Mini resize grip is not visible');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    await expect.poll(rect).toEqual({ ...moved, width: moved.width + 40, height: moved.height + 30 });

    // Pin is a header button; its pointer gesture must not move or resize the Mini.
    const resized = await rect();
    await page.getByRole('button', { name: /^(Keep on top|Stop keeping on top)$/ }).click();
    await expect.poll(rect).toEqual(resized);
    await page.mouse.move(200, 200);
    await expect.poll(rect).toEqual(resized);
    if (state === 'project-only') {
      await expect(page.getByRole('button', { name: 'View changes' })).toHaveCount(0);
      await expect(page.getByRole('img', { name: 'Project architecture map' })).toBeVisible();
    }
  });
}
