import { expect, test, type Page } from '@playwright/test';
const fixtureModule = '/tests/visual/fixtures/presence.tsx';

const mount = async (page: Page, time: number) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/harness.html?view=expanded&chrome=0&t=' + time);
  await page.evaluate(async path => { (await import(path)).mountPresenceFixture({ canonical: true }); }, fixtureModule);
  const fixture = page.locator('#presence-fixture');
  await expect(fixture.getByText('Presence fixture · no real telemetry')).toBeVisible();
  await expect(fixture.locator('.status[data-presence="connected"]')).toBeVisible();
  return fixture;
};

for (const surface of ['island', 'mini'] as const) {
  for (const recent of [true, false]) {
    test(surface + ' retains ' + (recent ? 'recent activity' : 'presence copy after activity expiry') + ' with attention/failure precedence', async ({ page }) => {
      await page.clock.install();
      const fixture = await mount(page, 4); // The session remains working across recency expiry.
      await page.evaluate(async ({ path, surface }) => { (await import(path)).setMode(surface); }, { path: fixtureModule, surface });
      for (const [state, label, token] of [
        ['attention', 'Migration file added', '--raio-color-accent-warning'],
        ['failure', 'Tests failed', '--raio-color-accent-danger'],
      ] as const) {
        await page.evaluate(async ({ path, state }) => { (await import(path)).setPresence(state); }, { path: fixtureModule, state });
        if (!recent) await page.clock.fastForward(31_000);
        const text = fixture.locator(surface === 'island' ? '.island__label' : '.mini__state');
        await expect(text).toHaveText(recent ? (surface === 'island' ? 'Claude · API' : 'Claude working') : new RegExp('^' + label + ' · \\d{2}:\\d{2}$'));
        const accessible = fixture.locator(surface === 'island' ? '.island' : '.mini__status');
        await expect(accessible).toHaveAttribute('aria-label', new RegExp(label));
        await expect(accessible).toHaveAttribute('title', new RegExp(label));
        if (surface === 'mini') await expect(text).toHaveAttribute('title', new RegExp(label));
        else await expect(fixture.locator('.mini-orb')).toHaveAttribute('data-presence', state);
        const dot = fixture.locator(surface === 'island' ? '.island__dot' : '.mini__status');
        await expect(dot).toHaveAttribute('data-presence', state);
        const expected = await dot.evaluate((el, token) => {
          const probe = document.createElement('i');
          probe.style.color = 'var(' + token + ')';
          el.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }, token);
        await expect.poll(() => dot.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(expected);
      }
    });
  }
}
