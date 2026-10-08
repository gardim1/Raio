import { expect, test, type Page } from '@playwright/test';
import type { SidebarFixtureState } from './fixtures/sidebar';

const longFolderName = 'Pasta com acentos ação e espaços ' + 'muito longa '.repeat(8);

const mount = async (page: Page, state: SidebarFixtureState) => {
  await page.goto('/harness.html?view=expanded&project-only=1&t=0&chrome=0');
  await page.evaluate(async value => {
    const modulePath = '/tests/visual/fixtures/sidebar.tsx';
    const { mountSidebarFixture } = await import(modulePath);
    mountSidebarFixture(value);
  }, state);
  return page.locator('#sidebar-fixture');
};

for (const width of [960, 1296, 1920]) {
  test(`long name, keyboard disclosure and controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mount(page, 'mapped');
    const sidebar = fixture.locator('.sidebar');
    const name = sidebar.locator('.sidebar__eyebrowless');
    await expect(name).toHaveText(longFolderName);
    await expect(name).toHaveAccessibleName(longFolderName);
    await expect(name).toHaveAttribute('title', longFolderName);
    expect(await name.evaluate(element => {
      const style = getComputedStyle(element);
      return style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth;
    })).toBe(true);
    expect(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(sidebar.getByText(longFolderName, { exact: true })).toHaveCount(1);
    await expect(sidebar.getByText('Connected · no activity yet', { exact: true })).toBeVisible();
    await expect(sidebar.getByText(/^\d+ areas? · heuristic map$/)).toBeVisible();
    await expect(fixture.getByText(/^(?:Heuristic map|\d+ areas? · heuristic map)$/)).toHaveCount(1);
    await expect(fixture.locator('.footer')).toHaveText('Project map');
    await expect(fixture.getByText('Start a new Claude Code session in this folder.', { exact: false })).toHaveCount(1);
    const button = sidebar.getByRole('button', { name: 'About this map', exact: true });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const details = sidebar.locator('[id]').filter({ hasText: 'Areas are a heuristic guess' });
    await expect(details).toBeHidden();
    // Tab from the top: surface buttons precede the disclosure. No pointer use.
    for (let attempt = 0; attempt < 8 && !await button.evaluate(element => element === document.activeElement); attempt++) await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeVisible();
    await expect(button).toHaveAttribute('aria-controls', await details.getAttribute('id') ?? '');
    await page.keyboard.press('Space');
    await expect(details).toBeHidden();
    await page.keyboard.press('Tab');
    await expect(sidebar.getByRole('button', { name: 'Disconnect', exact: true })).toBeFocused();
  });
}

const states: readonly [SidebarFixtureState, string, string?][] = [
  ['pending', 'Mapping project…'], ['empty', 'No code to map yet'], ['unrecognized', 'No areas recognized'],
  ['partial', 'Map incomplete', 'The project listing was partial'], ['skipped', 'Map incomplete', '2 files or folders not listed'],
  ['stale', 'Map incomplete', 'The latest relisting failed'], ['unavailable', "Couldn't list this folder"],
  ['denied', "Couldn't list this folder", 'Access denied by the filesystem'], ['mapped', 'Waiting for activity'],
  ['health', 'Activity cannot be confirmed', 'raio-hook was not found'], ['outdated', 'Activity cannot be confirmed', 'Hooks out of date'],
];
for (const [state, heading, warning] of states) {
  test(`truthful ${state} state`, async ({ page }) => {
    const fixture = await mount(page, state);
    await expect(fixture.locator('.sidebar__task')).toHaveText(heading);
    await expect(fixture.getByRole('button', { name: 'Choose another folder', exact: true })).toHaveCount(state === 'empty' ? 1 : 0);
    if (warning) {
      const notice = state === 'denied' ? fixture.getByText(warning, { exact: true }) : fixture.getByRole('status', { name: new RegExp(warning) });
      await expect(notice).toBeVisible();
      await expect(fixture.locator('.map-about')).not.toContainText(warning);
    }
    if (state === 'unavailable') await expect(fixture).not.toContainText('Access denied');
    if (state === 'health') for (const reason of ['3 event(s)', 'The file watcher overflowed', 'Local history was unreadable']) {
      await expect(fixture.locator('.evidence__warn').filter({ hasText: reason })).toBeVisible();
    }
  });
}

test('another folder requires preview and explicit Connect; Cancel preserves the project', async ({ page }) => {
  const fixture = await mount(page, 'empty');
  const actions = fixture.getByRole('status', { name: 'Synthetic settings actions' });
  await fixture.getByRole('button', { name: 'Choose another folder', exact: true }).click();
  const review = fixture.locator('.connect--sidebar-review');
  await expect(review).toContainText('Connect Claude Code in this project?');
  await expect(actions).toHaveText('0 writes · 0 disconnects');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fixture.locator('.sidebar__eyebrowless')).toHaveText(longFolderName);
  await expect(actions).toHaveText('0 writes · 0 disconnects');
  await fixture.getByRole('button', { name: 'Choose another folder', exact: true }).click();
  await review.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(actions).toHaveText('1 writes · 0 disconnects');
  await expect(fixture.locator('.sidebar__eyebrowless')).toHaveText('another');
});

test('disconnected uses the normal review flow without following claims', async ({ page }) => {
  const fixture = await mount(page, 'disconnected');
  await expect(fixture.getByText('No project yet', { exact: true })).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Choose a folder', exact: true })).toBeVisible();
  await expect(fixture).not.toContainText('follows');
  await fixture.getByRole('button', { name: 'Choose a folder', exact: true }).click();
  await expect(fixture.locator('.connect--review')).toContainText('Connect Claude Code in this project?');
});

test('session warnings stay visible with details closed and area selection still opens the inspector', async ({ page }) => {
  const fixture = await mount(page, 'session');
  await expect(fixture.locator('.sidebar')).not.toContainText('Start a new Claude');
  await expect(fixture.getByRole('status', { name: /The scan was partial/ })).toBeVisible();
  const about = fixture.getByRole('button', { name: 'About this map', exact: true });
  await expect(about).toHaveAttribute('aria-expanded', 'false');
  await expect(fixture.getByText(/^(?:Heuristic map|\d+ areas? · heuristic map)$/)).toHaveCount(1);
  await expect(fixture.locator('.footer')).not.toContainText(/heuristic/i);
  await fixture.locator('.arch-node[aria-label="Auth"]').click();
  await expect(fixture.getByRole('region', { name: 'Auth details', exact: true })).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Close details', exact: true })).toBeVisible();
});

test('Space operates the map disclosure during replay without triggering the global replay shortcut', async ({ page }) => {
  const fixture = await mount(page, 'replay');
  const about = fixture.getByRole('button', { name: 'About this map', exact: true });
  await about.focus();
  await page.keyboard.press('Space');
  await expect(about).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(about).toHaveAttribute('aria-expanded', 'false');
});
