import { expect, test, type Page } from '@playwright/test';
import type { CookieUsageFixtureControls } from './fixtures/cookie-usage';

const mount = async (page: Page, options = {}) => {
  await page.goto('/harness.html?view=expanded&project-only=1&t=4.15&chrome=0');
  await page.evaluate(async value => {
    const modulePath = '/tests/visual/fixtures/cookie-usage.tsx';
    const { mountCookieUsageFixture } = await import(modulePath);
    mountCookieUsageFixture(value);
  }, options);
  const fixture = page.locator('#cookie-usage-fixture');
  await expect(fixture.locator('.expanded__map .raio-char__body')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  return fixture;
};
const advance = (page: Page, seconds: number) => page.evaluate(value => (window as Window & CookieUsageFixtureControls).__cookieAdvance(value), seconds);

for (const session of [false, true]) {
  test(`cookie reaches the visible map character without changing ${session ? 'session' : 'project-only'} state`, async ({ page }) => {
    const fixture = await mount(page, { session });
    const before = await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieUi());
    const presence = await fixture.locator('.app').getAttribute('data-companion-state');
    const moods = await fixture.locator('[data-character-mode]').evaluateAll(elements => elements.map(element => element.getAttribute('data-character-mode')));
    const cookie = fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true });
    await expect(cookie).toHaveAttribute('title', 'Give Raio a cookie');
    await cookie.click(); await cookie.click();
    await expect(fixture.locator('.cookie-flight')).toHaveCount(1);
    expect(await fixture.locator('.cookie-flight').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    await advance(page, .25);
    await expect(fixture.locator('.raio-char__cookie')).toHaveCount(0);
    await page.setViewportSize({ width: 1100, height: 780 });
    await fixture.evaluate(element => { element.style.zoom = '1.1'; });
    await advance(page, .24);
    const distance = await fixture.evaluate(element => {
      const cookie = element.querySelector('.cookie-flight__drawing')!.getBoundingClientRect();
      const m = element.querySelector<SVGGraphicsElement>('.expanded__map .raio-char__drawing')!.getScreenCTM()!;
      return Math.hypot(cookie.left + cookie.width / 2 - (m.e + m.c * 4.5), cookie.top + cookie.height / 2 - (m.f + m.d * 4.5));
    });
    expect(distance).toBeLessThan(1);
    await advance(page, .01);
    await expect(fixture.locator('.cookie-flight')).toHaveCount(0);
    await expect(fixture.locator('.expanded__map .raio-char__cookie')).toHaveCount(1);
    await expect(fixture.locator('.titlebar .raio-char__cookie')).toHaveCount(0);
    await cookie.click();
    await expect(fixture.locator('.cookie-flight')).toHaveCount(0);
    await advance(page, .07);
    await expect(fixture.locator('.expanded__map .raio-char__crumb')).toHaveCount(3);
    await advance(page, .5);
    await expect(fixture.locator('.expanded__map .raio-char__heart')).toHaveCount(1);
    await advance(page, 4);
    await expect(fixture.locator('.raio-char__cookie, .raio-char__crumb, .raio-char__heart, .cookie-flight')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieUi())).toEqual(before);
    await expect(fixture.locator('.app')).toHaveAttribute('data-companion-state', presence!);
    expect(await fixture.locator('[data-character-mode]').evaluateAll(elements => elements.map(element => element.getAttribute('data-character-mode')))).toEqual(moods);
    await expect(fixture.locator('.expanded')).toBeVisible();
    await expect(fixture.locator('.titlebar__actions button')).toHaveCount(3); // disabled usage hidden
  });
}

test('off-screen map falls back to the title-bar character; keyboard cookie preserves replay state', async ({ page }) => {
  const fixture = await mount(page, { session: true });
  await page.evaluate(async () => {
    const modulePath = '/src/features/session/store/sessionStore.ts';
    const { useSessionUi } = await import(modulePath);
    useSessionUi.setState({ source: 'replay' });
  });
  await expect(fixture.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await fixture.locator('.raio-orb').evaluate(element => element.setAttribute('transform', 'translate(-1000 -1000)'));
  const cookie = fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true });
  await cookie.focus(); await page.keyboard.press('Space'); await advance(page, .5);
  await expect(fixture.locator('.titlebar .raio-char__cookie')).toHaveCount(1);
  await expect(fixture.locator('.expanded__map .raio-char__cookie')).toHaveCount(0);
  await expect(fixture.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  expect((await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieUi())).source).toBe('replay');
});

test('hidden surface cancels in flight with no delayed reaction or orphan overlay', async ({ page }) => {
  const fixture = await mount(page);
  await fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true }).click();
  await advance(page, .2);
  await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieVisible(false));
  await expect(fixture.locator('.cookie-flight')).toHaveCount(0);
  await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieVisible(true));
  await advance(page, 3);
  await expect(fixture.locator('.raio-char__cookie, .raio-char__crumb, .raio-char__heart')).toHaveCount(0);
  await fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true }).click();
  await page.evaluate(() => (window as Window & CookieUsageFixtureControls).__cookieUnmount());
  await expect(page.locator('.cookie-flight')).toHaveCount(0);
});

test('reduced motion has no flight or crumbs and retains the approved still-cookie branch', async ({ page }) => {
  const fixture = await mount(page, { reduced: true });
  await fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true }).click();
  await expect(fixture.locator('.cookie-flight')).toHaveCount(0);
  await advance(page, .4);
  await expect(fixture.locator('.expanded__map .raio-char__cookie')).toHaveAttribute('transform', 'translate(0 -19)');
  await expect(fixture.locator('.raio-char__crumb')).toHaveCount(0);
  await advance(page, .5);
  await expect(fixture.locator('.expanded__map .raio-char__heart')).toHaveCount(1);
  await advance(page, 3);
  await expect(fixture.locator('.raio-char__cookie, .raio-char__heart')).toHaveCount(0);
});

test('approved cookie flight and arrival visual review (new goldens required)', async ({ page }) => {
  const fixture = await mount(page);
  await fixture.getByRole('button', { name: 'Give Raio a cookie', exact: true }).click();
  await advance(page, .25);
  await expect(fixture.locator('.expanded')).toHaveScreenshot('expanded-cookie-flight.png');
  await advance(page, .85);
  await expect(fixture.locator('.expanded__map .raio-char__heart')).toHaveCount(1);
  await expect(fixture.locator('.expanded')).toHaveScreenshot('expanded-cookie-arrival.png');
});
