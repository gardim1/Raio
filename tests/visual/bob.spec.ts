import { expect, test } from '@playwright/test';

/** C-CHAR supersedes the finite BOB-1 float: rest is quiet immediately. */
test('idle Island character retains connected presence with no CSS float', async ({ page }) => {
  // Connected project without session observations: no migration notice or recent activity.
  await page.goto('/harness.html?view=island&t=11&project-only=1');
  await page.evaluate(() => document.fonts.ready);
  const orb = page.locator('.island .mini-orb');
  await expect(orb).toHaveCount(1);
  await expect(orb).toHaveAttribute('data-presence', 'connected');
  await expect(orb.locator('[data-character-mode]')).toHaveAttribute('data-character-mode', 'idle');
  await expect(page.locator('.mini-orb--bob')).toHaveCount(0);
  const rest = await orb.evaluate((el) => {
    return { running: el.getAnimations().length, transform: getComputedStyle(el).transform, animation: getComputedStyle(el).animationName };
  });
  expect(rest.running).toBe(0);
  expect(rest.animation).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(rest.transform);
});

test('live idle character bench settles all sizes and stops requesting frames', async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as Window & { characterFrameRequests?: number };
    target.characterFrameRequests = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { target.characterFrameRequests = (target.characterFrameRequests ?? 0) + 1; return request(callback); };
  });
  // Deliberately no ?t= or capture: this verifies the live loop's idle behavior.
  await page.goto('/harness.html?view=character&chrome=0');
  await page.evaluate(() => document.fonts.ready);
  const bodies = page.locator('.character-bench .raio-char__body');
  await expect(bodies).toHaveCount(3);
  const poses = () => bodies.evaluateAll(elements => elements.map(element => element.getAttribute('transform')));
  const requests = () => page.evaluate(() => (window as Window & { characterFrameRequests?: number }).characterFrameRequests ?? 0);
  const before = await poses(), frames = await requests();
  await page.waitForTimeout(250);
  expect(await poses()).toEqual(before);
  expect(await requests()).toBe(frames);
  await expect(page.locator('[data-character-mode="idle"]')).toHaveCount(3);
});
