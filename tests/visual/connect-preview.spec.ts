import { expect, test, type Locator } from '@playwright/test';

const hitTarget = async (target: Locator, selector: string) => {
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((element, selector) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit?.closest(selector) === element;
  }, selector)).toBe(true);
};

for (const initial of [true, false]) {
  test(`Connect preview ${initial ? 'folder intent' : 'folder choice'} leaves native-sized titlebar and dots hit-testable`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/harness.html?view=expanded&chrome=0&t=0');
    await page.evaluate(async initial => {
      const path = '/tests/visual/fixtures/connect-preview.tsx';
      (await import(path)).mountConnectPreviewFixture(initial ? 'C:/fixture/Intent folder' : undefined);
    }, initial);
    const fixture = page.locator('#connect-preview-fixture');
    if (!initial) await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
    await expect(fixture.locator('.titlebar__project')).toHaveText(initial ? 'Intent folder' : 'Chosen folder');
    const map = fixture.getByRole('img', { name: 'Project architecture map' });
    await expect(map).toBeVisible();
    const titlebar = fixture.locator('.titlebar');
    await hitTarget(titlebar, '.titlebar');
    for (const name of ['Close window', 'Minimize window', 'Maximize or restore window']) {
      await hitTarget(fixture.getByRole('button', { name, exact: true }), 'button');
    }
    const mapBox = (await map.boundingBox())!;
    const cardBox = (await fixture.locator('.connect--review').boundingBox())!;
    const titleBox = (await titlebar.boundingBox())!;
    expect(mapBox.width).toBeGreaterThan(400);
    expect(mapBox.height).toBeGreaterThanOrEqual(220);
    expect(mapBox.x + mapBox.width).toBeLessThanOrEqual(cardBox.x);
    expect(mapBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    const actions = fixture.getByLabel('Fixture actions');
    await expect(actions).toContainText('"connect":0');
    await fixture.locator('.titlebar__brand').dblclick();
    await expect(actions).toContainText('"drag":1');
    await expect(actions).toContainText('"maximize":1');
    await fixture.getByRole('button', { name: 'Minimize window', exact: true }).click();
    await expect(actions).toContainText('"minimize":1');
    await fixture.getByRole('button', { name: 'Maximize or restore window', exact: true }).click();
    await expect(actions).toContainText('"maximize":2');
    await fixture.getByRole('button', { name: 'Close window', exact: true }).click();
    await expect(actions).toContainText('"close":1');
    // A narrow window stacks the map above the card and still leaves chrome exposed.
    await page.setViewportSize({ width: 700, height: 650 });
    await hitTarget(titlebar, '.titlebar');
    for (const name of ['Close window', 'Minimize window', 'Maximize or restore window']) {
      await hitTarget(fixture.getByRole('button', { name, exact: true }), 'button');
    }
    await fixture.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(fixture.getByRole('button', { name: 'Choose a folder', exact: true })).toBeVisible();
    await expect(actions).toContainText('"connect":0');
    await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
    await expect(fixture.locator('.titlebar__project')).toHaveText('Chosen folder');
    await expect(map).toBeVisible();
    await expect(actions).toContainText('"connect":0');
  });
}
