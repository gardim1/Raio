import { expect, test, type Page } from '@playwright/test';
import type { FixturePresence } from './fixtures/presence';
const fixtureModule = '/tests/visual/fixtures/presence.tsx';

const mount = async (page: Page, frozen = true) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/harness.html?view=expanded&chrome=0' + (frozen ? '&t=8' : ''));
  await page.evaluate(async path => { (await import(path)).mountPresenceFixture(); }, fixtureModule);
  const fixture = page.locator('#presence-fixture');
  await expect(fixture.getByText('Presence fixture · no real telemetry')).toBeVisible();
  await expect(fixture.locator('.status[data-presence="connected"]')).toBeVisible();
  return fixture;
};
const state = async (page: Page, value: FixturePresence) => page.evaluate(async ({ path, value }) => { (await import(path)).setPresence(value); }, { path: fixtureModule, value });
const mode = async (page: Page, value: 'island' | 'mini' | 'expanded') => page.evaluate(async ({ path, value }) => { (await import(path)).setMode(value); }, { path: fixtureModule, value });

test('presence uses the existing tokens, labels and distinct unknown/disconnected symbols', async ({ page }) => {
  const fixture = await mount(page);
  for (const [value, label, token] of [
    ['connected', 'Connected · quiet', '--raio-color-text-primary'],
    ['working', 'Recent activity', '--raio-color-accent-cool'],
    ['attention', 'Migration file added', '--raio-color-accent-warning'],
    ['failure', 'Tests failed', '--raio-color-accent-danger'],
    ['unknown', 'Status unavailable', '--raio-color-text-primary'],
    ['disconnected', 'Disconnected · no project', '--raio-color-text-primary'],
  ] as const) {
    await state(page, value);
    const pill = fixture.locator('.status[data-presence="' + value + '"]');
    await expect(pill).toHaveAttribute('aria-label', new RegExp(label));
    await expect(pill.locator('.status__label')).toContainText(label);
    await expect(pill.locator('.status__dot')).toHaveCSS('transition-duration', '0s');
    const expected = await pill.evaluate((el, token) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(' + token + ')';
      el.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);
    await expect.poll(() => pill.locator('.status__dot').evaluate(dot =>
      getComputedStyle(dot)[dot.textContent ? 'color' : 'backgroundColor'],
    )).toBe(expected);
    if (value === 'unknown' || value === 'disconnected') await expect(pill.locator('.status__dot')).toHaveText(value === 'unknown' ? '?' : '−');
  }
});

test('all surfaces show the same factual failure and the inspector retains historical failures', async ({ page }) => {
  const fixture = await mount(page);
  await state(page, 'failure');
  for (const surface of ['island', 'mini', 'expanded'] as const) {
    await mode(page, surface);
    await expect(fixture.locator('[data-presence="failure"]').first()).toBeVisible();
    await expect(fixture.locator('[title*="Tests failed"]').first()).toHaveAttribute('title', /Demo fixture check/);
  }
  const history = fixture.getByRole('region', { name: 'Recorded project observations' });
  await expect(history).toContainText('Tests failed');
  await state(page, 'historical');
  await expect(fixture.locator('.status')).toHaveAttribute('data-presence', 'working');
  await expect(history.locator('.presence-record--historical')).toContainText('Failed earlier · code changed since');
  await state(page, 'passed');
  await expect(history.locator('.presence-record--historical')).toContainText('Failed earlier · later pass recorded');
  await expect(history).toContainText('Demo fixture check');
});

test('open live sessions are in progress in Expanded and Mini; a recorded end is Complete', async ({ page }) => {
  const fixture = await mount(page);
  await expect(fixture.locator('.evidence__note').filter({ hasText: 'Last recorded session:' }).first()).toContainText('Session in progress');
  await mode(page, 'mini');
  await expect(fixture.locator('.mini__project')).toHaveAttribute('title', /Session in progress/);
  await page.evaluate(async path => { (await import(path)).finishSession(); }, fixtureModule);
  await expect(fixture.locator('.mini__project')).toHaveAttribute('title', /Complete \(end recorded\)/);
  await mode(page, 'expanded');
  await expect(fixture.locator('.evidence__note').filter({ hasText: 'Last recorded session:' }).first()).toContainText('Complete (end recorded)');
});

test('hidden surfaces pause graphics and keep rendered data frozen until latest-state reconciliation', async ({ page }) => {
  const fixture = await mount(page, false);
  await mode(page, 'mini');
  const rect = await fixture.locator('.mini').evaluate(el => { const s = (el as HTMLElement).style; return [s.left, s.top, s.width, s.height]; });
  await page.evaluate(async path => { (await import(path)).setVisible(false); }, fixtureModule);
  await expect(page.locator('html')).toHaveClass(/surface-hidden/);
  await expect(fixture.locator('.mini')).toBeHidden();
  // Let Activity clean effects before counting any subsequent renderer work.
  await page.waitForTimeout(100);
  const before = await fixture.locator('.app').innerHTML();
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    (window as unknown as { hiddenFrames: number }).hiddenFrames = 0;
    window.requestAnimationFrame = callback => original.call(window, at => {
      (window as unknown as { hiddenFrames: number }).hiddenFrames++;
      callback(at);
    });
  });
  await state(page, 'failure');
  await state(page, 'historical');
  await page.waitForTimeout(150);
  expect(await fixture.locator('.app').innerHTML()).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { hiddenFrames: number }).hiddenFrames)).toBe(0);
  const cssPaused = await fixture.locator('.mini__status').evaluate(el => getComputedStyle(el).animationPlayState);
  expect(cssPaused).toBe('paused');
  await page.evaluate(async path => { (await import(path)).setVisible(true); }, fixtureModule);
  await expect(fixture.locator('.mini')).toBeVisible();
  await expect(fixture.locator('.mini__status')).toHaveAttribute('data-presence', 'working');
  await expect(fixture.locator('.mini__state')).toHaveText('Recent activity');
  expect(await fixture.locator('.mini').evaluate(el => { const s = (el as HTMLElement).style; return [s.left, s.top, s.width, s.height]; })).toEqual(rect);
});

test('recent activity expires to neutral with reduced-motion graphics at rest', async ({ page }) => {
  await page.clock.install();
  const fixture = await mount(page);
  await state(page, 'working');
  await expect(fixture.locator('.status')).toHaveAttribute('data-presence', 'working');
  await page.clock.fastForward(31_000);
  await expect(fixture.locator('.status')).toHaveAttribute('data-presence', 'connected');
  await expect(fixture.locator('.status__label')).toHaveText('Connected · quiet');
  await mode(page, 'island');
  expect(await fixture.locator('.mini-orb').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await fixture.locator('.island__dot').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await expect(fixture.locator('.island__label')).toContainText('Connected · quiet');
});

test('Activity reveal preserves a paused replay position and a new request still restarts it', async ({ page }) => {
  const fixture = await mount(page, false);
  await page.evaluate(async () => {
    const path = '/src/features/session/store/sessionStore.ts';
    (await import(path)).useSessionUi.getState().startReplay();
  });
  await fixture.getByRole('button', { name: 'Pause replay', exact: true }).click();
  const slider = fixture.getByRole('slider', { name: 'Replay position' });
  // Seek through the actual keyboard handler, independently of the native clock.
  await slider.focus();
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowRight');
  const position = await slider.getAttribute('aria-valuenow');
  expect(Number(position)).toBeGreaterThanOrEqual(7);
  await page.evaluate(async path => { (await import(path)).setVisible(false); }, fixtureModule);
  await expect(slider).toBeHidden();
  await page.waitForTimeout(100); // Activity cleanup must finish before reconnecting.
  await page.evaluate(async path => { (await import(path)).setVisible(true); }, fixtureModule);
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuenow', position!);
  await expect(fixture.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/features/session/store/sessionStore.ts';
    (await import(path)).useSessionUi.getState().startReplay();
  });
  await expect(fixture.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeLessThan(Number(position));
});
