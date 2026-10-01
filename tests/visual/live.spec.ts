import { expect, test } from '@playwright/test';

/**
 * The live director following a simulated feed (dev harness `?feed=`, demo fixture, not real telemetry).
 * `t` freezes the feed clock: the harness replays the feed and the director deterministically up to that
 * many seconds, so each frame is reproducible. Times chosen from the steady feed's timeline:
 *   1.0  Raio asleep/waking, nothing touched yet      2.4  approach and orbit around Auth
 *   8.0  parked above Frontend (Auth already active)   20   parked above Database with the migration notice
 *   36   session ended, settled end-state view
 * and from the burst feed (ten events within a third of a second): 3.0 mid catch-up (time-compressed).
 */
const SCENES = [
  { name: 'live-steady-wake', query: 'view=expanded&feed=steady&t=1' },
  { name: 'live-steady-orbit-auth', query: 'view=expanded&feed=steady&t=2.4' },
  { name: 'live-steady-parked-frontend', query: 'view=expanded&feed=steady&t=8' },
  { name: 'live-steady-migration-notice', query: 'view=expanded&feed=steady&t=20' },
  { name: 'live-steady-ended', query: 'view=expanded&feed=steady&t=36' },
  { name: 'live-burst-catching-up', query: 'view=expanded&feed=burst&t=3' },
  { name: 'live-island-parked', query: 'view=island&feed=steady&t=8' },
  { name: 'live-mini-migration-notice', query: 'view=mini&feed=steady&t=20' },
] as const;

for (const scene of SCENES) {
  test(scene.name, async ({ page }) => {
    await page.goto(`/harness.html?${scene.query}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200); // let one-shot CSS/motion entrances settle
    await expect(page).toHaveScreenshot(`${scene.name}.png`);
  });
}
