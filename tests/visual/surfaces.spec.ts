import { expect, test } from '@playwright/test';

/** Product surfaces rendered from the demo fixture at fixed times (seconds into the session). */
const SCENES = [
  { name: 'island-working', query: 'view=island&t=4.15' },
  { name: 'island-finished', query: 'view=island&t=11' },
  { name: 'mini-working', query: 'view=mini&t=4.15' },
  { name: 'mini-complete', query: 'view=mini&t=12' },
  { name: 'expanded-scanning-auth', query: 'view=expanded&t=2.5' },
  { name: 'expanded-migration', query: 'view=expanded&t=6.3' },
  { name: 'expanded-complete', query: 'view=expanded&t=12' },
  { name: 'replay-expanded', query: 'view=expanded&replay=1&t=5' },
  { name: 'replay-mini', query: 'view=mini&replay=1&t=5' },
] as const;

for (const scene of SCENES) {
  test(scene.name, async ({ page }) => {
    await page.goto(`/harness.html?${scene.query}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200); // let one-shot CSS/motion entrances settle
    await expect(page).toHaveScreenshot(`${scene.name}.png`);
  });
}
