import { expect, test } from '@playwright/test';

// Synthetic harness data only. Published native hit rectangles are covered by Vitest;
// browser geometry complements, but cannot prove native click-through/focus/DPI.
for (const projectOnly of [false,true]) {
  test(`Island usage stays contained and reachable by pointer and keyboard (${projectOnly?'quiet':'session'})`, async ({page}) => {
    await page.goto(`/harness.html?view=island&t=4&chrome=0&usage=reading${projectOnly?'&project-only=1':''}`);
    const island=page.locator('.island'), disclosure=island.getByRole('button',{name:/^Raio: /});
    const rings=island.getByRole('button',{name:'Claude plan usage',exact:true});
    await expect(rings).toHaveCount(0); // No subscription, age timer or details in the closed capsule.
    await disclosure.hover();
    await expect(island.locator('.island__identity')).toBeVisible();
    await expect(island.locator('.island__usage-summary')).toHaveText('5h 42% · week 68% used');
    await rings.hover();
    const details=island.getByRole('region',{name:'Claude plan usage details',exact:true});
    await expect(details).toBeVisible();
    await details.hover(); await page.waitForTimeout(300);
    await expect(island).toHaveAttribute('aria-expanded','true');
    const box=(await island.boundingBox())!, detailBox=(await details.boundingBox())!;
    expect(box.width).toBe(340); expect(box.height).toBeLessThanOrEqual(462);
    expect(box.y+box.height+30).toBeLessThanOrEqual(500);
    expect(detailBox.x).toBeGreaterThanOrEqual(box.x);
    expect(detailBox.x+detailBox.width).toBeLessThanOrEqual(box.x+box.width);
    expect(detailBox.y+detailBox.height).toBeLessThanOrEqual(box.y+box.height);
    await page.mouse.move(0,550); await page.waitForTimeout(300);
    await expect(disclosure).toHaveAttribute('aria-expanded','false');
    await disclosure.focus(); await disclosure.press('Tab'); await expect(rings).toBeFocused();
    await rings.press('Enter'); await expect(details).toBeVisible();
    await page.keyboard.press('Tab'); await expect(details).toBeFocused();
    await page.keyboard.press('Escape'); await expect(details).toHaveCount(0);
    await expect(rings).toBeFocused(); await expect(disclosure).toHaveAttribute('aria-expanded','true');
    await rings.press('Space'); await expect(details).toBeVisible();
    await page.keyboard.press('Escape'); await expect(details).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(disclosure).toBeFocused();
    await expect(disclosure).toHaveAttribute('aria-expanded','false');
    await disclosure.press('Enter'); await disclosure.press('Tab');
    await page.keyboard.press('Tab'); // Details region, then the three existing actions.
    for (const name of ['Open Mini Player','Open window','Give Raio a cookie']) {
      await page.keyboard.press('Tab'); await expect(island.getByRole('button',{name,exact:true})).toBeFocused();
    }
    await page.keyboard.press('Enter'); await expect(island).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('.expanded')).toHaveCount(0); await expect(page.locator('.mini')).toHaveCount(0);
  });
}

for (const [usage,summary] of [['waiting','Usage unavailable'],['missing-weekly','5h 42% · week — used'],['expired','5h — · week 68% used']] as const) {
  test(`Island explains ${usage} without inventing zero usage`,async ({page}) => {
    await page.goto(`/harness.html?view=island&project-only=1&t=4&chrome=0&usage=${usage}`);
    const island=page.locator('.island'); await island.hover();
    await expect(island.locator('.island__usage')).toContainText(summary);
    await island.getByRole('button',{name:'Claude plan usage',exact:true}).focus();
    await expect(island.getByRole('region',{name:'Claude plan usage details',exact:true})).toBeVisible();
    await expect(island.locator('.usage-rings__fill[stroke-dasharray="0 100"]')).toHaveCount(0);
  });
}
