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

test('short native-sized viewport scrolls stale details and keeps the actions inside the animated Island', async ({page}) => {
  // Rust covers 728 physical px at 175%, including a top taskbar. This emulates the resulting webview.
  await page.setViewportSize({width:420,height:405});
  await page.goto('/harness.html?view=island&project-only=1&t=4&chrome=0&usage=stale');
  await page.evaluate(async()=>{
    // The harness only imports raio.css; production also loads the native surface overrides.
    const stylesheet='/src/platform/native.css';
    await import(stylesheet);
    document.documentElement.classList.add('native','surface-island');
  });
  await expect(page.locator('.island-dock')).toHaveCSS('top','0px');
  const island=page.locator('.island'), disclosure=island.getByRole('button',{name:/^Raio: /});
  await disclosure.focus();
  await expect.poll(async()=>Math.round((await island.boundingBox())!.height)).toBeGreaterThanOrEqual(144);
  const rings=island.getByRole('button',{name:'Claude plan usage',exact:true});
  await rings.focus();
  const details=island.getByRole('region',{name:'Claude plan usage details',exact:true});
  await expect(details).toContainText('Stale reading');
  // Include multi-source explanatory copy to stress the same bounded layout, with synthetic text only.
  await details.evaluate(node=>{const p=document.createElement('p');p.textContent='Source Claude Code session DEMO1234 · latest of 2 sources. Readings are not combined.';node.append(p);});
  await page.waitForTimeout(500);
  const box=(await island.boundingBox())!;
  expect(box.y).toBe(0); expect(box.y+box.height+30).toBeLessThanOrEqual(405);
  for(const name of ['Open Mini Player','Open window','Give Raio a cookie']) {
    const action=(await island.getByRole('button',{name,exact:true}).boundingBox())!;
    expect(action.y).toBeGreaterThanOrEqual(box.y); expect(action.y+action.height).toBeLessThanOrEqual(box.y+box.height);
  }
  const wrap=island.locator('.usage-details-wrap');
  expect(await wrap.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await wrap.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(island.getByRole('button',{name:'Open window',exact:true})).toBeVisible();
  await page.keyboard.press('Escape'); await expect(details).toHaveCount(0);
  // During the shrink, actions follow the actual box instead of their final expanded position.
  const samples=await island.evaluate(async root=>{
    const values:Array<{height:number,bottom:number,actionBottom:number}>=[];
    for(let n=0;n<6;n++) {
      await new Promise(requestAnimationFrame);
      const rect=root.getBoundingClientRect(), action=root.querySelector('.island__actions')!.getBoundingClientRect();
      values.push({height:rect.height,bottom:rect.bottom,actionBottom:action.bottom});
    }
    return values;
  });
  for(const sample of samples) expect(sample.actionBottom).toBeLessThanOrEqual(sample.bottom+1);
  await page.keyboard.press('Escape'); await expect(disclosure).toHaveAttribute('aria-expanded','false');
});

for(const reduced of [false,true]) {
  test(`Island interpolates height and preview opacity (${reduced?'reduced':'normal'} motion)`,async ({page})=>{
    await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
    await page.goto('/harness.html?view=island&project-only=1&t=4&chrome=0&usage=reading');
    const island=page.locator('.island'), disclosure=island.getByRole('button',{name:/^Raio: /});
    const result=await island.evaluate(async root=>{
      const header=root.querySelector<HTMLButtonElement>('.island__trigger')!, preview=root.querySelector<HTMLElement>('.island__preview')!;
      header.focus();
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const sample=()=>({height:root.getBoundingClientRect().height,opacity:Number(getComputedStyle(preview).opacity)});
      const transitions=(element:Element)=>element.getAnimations().filter((animation):animation is CSSTransition=>animation instanceof CSSTransition);
      const openingHeight=transitions(root).find(animation=>animation.transitionProperty==='height');
      const openingFade=transitions(preview).find(animation=>animation.transitionProperty==='opacity');
      const timings={height:openingHeight?.effect?.getTiming().duration,fade:openingFade?.effect?.getTiming().duration,delay:openingFade?.effect?.getTiming().delay};
      // Sample transitions at deterministic times instead of relying on a busy CI machine's wall clock.
      for(const animation of [openingHeight,openingFade]) if(animation) {animation.pause();animation.currentTime=50;}
      const opening=sample();
      for(const animation of [openingHeight,openingFade]) if(animation) animation.currentTime=1000;
      const open=sample();
      header.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const closingTransitions=[...transitions(root),...transitions(preview)];
      for(const animation of closingTransitions) {animation.pause();animation.currentTime=50;}
      const closing=sample();
      for(const animation of closingTransitions) animation.currentTime=1000;
      return {opening,open,closing,closed:sample(),timings};
    });
    expect(result.open.height).toBeGreaterThanOrEqual(144); expect(result.open.opacity).toBe(1); expect(result.closed.height).toBe(34); expect(result.closed.opacity).toBe(0);
    if(reduced) {
      expect(result.opening.height).toBe(result.open.height); expect(result.opening.opacity).toBe(1);
      expect(result.closing.height).toBe(34); expect(result.closing.opacity).toBe(0);
    } else {
      expect(result.timings).toEqual({height:420,fade:200,delay:100});
      expect(result.opening.height).toBeGreaterThan(34); expect(result.opening.height).toBeLessThan(result.open.height);
      expect(result.opening.opacity).toBe(0); // Approved 100ms entry delay.
      expect(result.closing.height).toBeGreaterThan(34); expect(result.closing.height).toBeLessThan(result.open.height);
      expect(result.closing.opacity).toBeGreaterThan(0); expect(result.closing.opacity).toBeLessThan(1);
    }
    await expect(disclosure).toHaveAttribute('aria-expanded','false');
  });
}
