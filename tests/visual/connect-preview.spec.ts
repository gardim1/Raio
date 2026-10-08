import { expect, test, type Locator } from '@playwright/test';
const closeLabel = 'Close (Raio keeps running; quit from the tray)';

const hitTarget = async (target: Locator, selector: string) => {
  await expect(target).toBeVisible();
  await expect.poll(() => target.evaluate((element, selector) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit?.closest(selector) === element;
  }, selector)).toBe(true);
};

for (const initial of [true, false]) {
  test(`Connect preview ${initial ? 'folder intent' : 'folder choice'} leaves native-sized titlebar and captions hit-testable`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/harness.html?view=expanded&chrome=0&t=0');
    await page.evaluate(async initial => {
      const path = '/tests/visual/fixtures/connect-preview.tsx';
      (await import(path)).mountConnectPreviewFixture(initial ? 'C:/fixture/Intent folder' : undefined);
    }, initial);
    const fixture = page.locator('#connect-preview-fixture');
    if (!initial) {
      // The empty/no-project state uses the same chrome before any map or settings review exists.
      for (const name of ['Minimize', 'Maximize', closeLabel]) await hitTarget(fixture.getByRole('button', { name, exact: true }), 'button');
      await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
    }
    await expect(fixture.locator('.titlebar__project')).toHaveText(initial ? 'Intent folder' : 'Chosen folder');
    const map = fixture.getByRole('img', { name: 'Project architecture map' });
    await expect(map).toBeVisible();
    const titlebar = fixture.locator('.titlebar');
    await hitTarget(titlebar, '.titlebar');
    await expect(fixture.locator('.titlebar__dots')).toHaveCount(0);
    expect(await fixture.getByRole('group', { name: 'Window controls' }).getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Minimize', 'Maximize', closeLabel]);
    for (const name of ['Minimize', 'Maximize', closeLabel]) {
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
    const taskBox = (await fixture.locator('.titlebar__task').boundingBox())!;
    const endBox = (await fixture.locator('.titlebar__end').boundingBox())!;
    expect(endBox.x - (taskBox.x + taskBox.width)).toBeGreaterThan(12);
    const empty = { x: (taskBox.x + taskBox.width + endBox.x) / 2, y: titleBox.y + titleBox.height / 2 };
    expect(await titlebar.evaluate((bar, point) => document.elementFromPoint(point.x, point.y) === bar, empty)).toBe(true);
    await page.mouse.click(empty.x, empty.y);
    await expect(actions).toContainText('"drag":1');
    await fixture.locator('.titlebar__brand').dblclick();
    await expect(actions).toContainText('"drag":2');
    await expect(actions).toContainText('"maximize":1');
    await expect(fixture.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await fixture.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(actions).toContainText('"minimize":1');
    await fixture.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(actions).toContainText('"maximize":2');
    await fixture.getByRole('button', { name: closeLabel, exact: true }).click();
    await expect(actions).toContainText('"close":1');
    // A narrow window stacks the map above the card and still leaves chrome exposed.
    await page.setViewportSize({ width: 700, height: 650 });
    await hitTarget(titlebar, '.titlebar');
    await fixture.locator('.titlebar__task b').evaluate(element => { element.textContent = 'A long task label '.repeat(60); });
    for (const name of ['Minimize', 'Maximize', closeLabel]) {
      await hitTarget(fixture.getByRole('button', { name, exact: true }), 'button');
    }
    const narrowBar = (await titlebar.boundingBox())!;
    const closeBox = (await fixture.getByRole('button', { name: closeLabel, exact: true }).boundingBox())!;
    expect(closeBox.width).toBe(46);
    expect(closeBox.height).toBeGreaterThanOrEqual(50);
    expect(closeBox.x + closeBox.width).toBeCloseTo(narrowBar.x + narrowBar.width, 0);
    await fixture.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(fixture.getByRole('button', { name: 'Choose a folder', exact: true })).toBeVisible();
    await expect(actions).toContainText('"connect":0');
    await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
    await expect(fixture.locator('.titlebar__project')).toHaveText('Chosen folder');
    await expect(map).toBeVisible();
    await expect(actions).toContainText('"connect":0');
  });
}

test('caption glyph and labels follow initial and external OS maximization; hover and focus remain visible', async ({ page }) => {
  await page.goto('/harness.html?view=expanded&chrome=0&t=0');
  await page.evaluate(async () => {
    const path = '/tests/visual/fixtures/connect-preview.tsx';
    (await import(path)).mountConnectPreviewFixture(undefined, true);
  });
  const fixture = page.locator('#connect-preview-fixture');
  const restore = fixture.getByRole('button', { name: 'Restore', exact: true });
  await expect(restore).toHaveAttribute('title', 'Restore');
  await expect(restore.locator('svg')).toHaveAttribute('data-window-glyph', 'restore');
  await expect(restore.locator('rect')).toHaveCount(2);
  await page.evaluate(async () => {
    const path = '/tests/visual/fixtures/connect-preview.tsx';
    (await import(path)).setFixtureMaximized(false);
  });
  const maximize = fixture.getByRole('button', { name: 'Maximize', exact: true });
  await expect(maximize).toHaveAttribute('title', 'Maximize');
  await expect(maximize.locator('svg')).toHaveAttribute('data-window-glyph', 'maximize');
  await expect(fixture.getByLabel('Fixture actions')).toContainText('"maximize":0');
  const close = fixture.getByRole('button', { name: closeLabel, exact: true });
  await close.hover();
  await expect(close).toHaveCSS('background-color', 'rgb(196, 43, 28)');
  await expect(close).toHaveCSS('color', 'rgb(255, 255, 255)');
  await fixture.getByRole('button', { name: 'Minimize', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(maximize).toBeFocused();
  await expect(maximize).toHaveCSS('outline-style', 'solid');
  await expect(maximize).toHaveCSS('outline-width', '2px');
});
