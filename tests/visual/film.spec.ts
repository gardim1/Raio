import { expect, test } from '@playwright/test';

/** The 9 canonical keyframes are renders of the concept film, so they are compared against the harness film view. */
const KEYFRAMES = [
  { file: '01-idle', t: 0.6 },
  { file: '02-agent-starts', t: 1.3 },
  { file: '03-auth-active', t: 2.5 },
  { file: '04-auth-to-api-traversal', t: 3.45 },
  { file: '05-api-active', t: 4.15 },
  { file: '06-database-warning', t: 5.55 },
  { file: '07-migration-notification', t: 6.3 },
  { file: '08-validations', t: 7.7 },
  { file: '09-completed', t: 10.0 },
] as const;

test.use({ viewport: { width: 1920, height: 1080 } });

for (const kf of KEYFRAMES) {
  test(`film ${kf.file}`, async ({ page }) => {
    await page.goto(`/harness.html?view=film&chrome=0&t=${kf.t}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot(`film-${kf.file}.png`);
  });
}
