import { expect, test } from '@playwright/test';

/** BOB-1: the idle float is a finite ~30 s animation (10 x 3 s) and rests at its base position afterwards. */
test('idle orb float is bounded to 10 iterations of 3 s, then rests', async ({ page }) => {
  await page.goto('/harness.html?view=island&t=11'); // finished session: collapsed Island, orb idle
  await page.evaluate(() => document.fonts.ready);
  const orb = page.locator('.island__closed .mini-orb--bob');
  await expect(orb).toHaveCount(1);

  const timing = await orb.evaluate((el) => {
    const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === 'raio-bob');
    const t = a?.effect?.getComputedTiming();
    return { found: !!a, iterations: t?.iterations, duration: t?.duration, endTime: t?.endTime };
  });
  expect(timing).toEqual({ found: true, iterations: 10, duration: 3000, endTime: 30000 });

  // Jump to the end instead of waiting 30 s: no running float, transform back at rest.
  const rest = await orb.evaluate((el) => {
    el.getAnimations().forEach((a) => a.finish());
    return { running: el.getAnimations().length, transform: getComputedStyle(el).transform };
  });
  expect(rest.running).toBe(0);
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(rest.transform);
});
