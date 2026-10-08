import { afterEach, expect, it, vi } from 'vitest';
import { observeIslandPreviewHeight } from './islandLayout';

afterEach(()=>vi.unstubAllGlobals());
it('measures explicit pixel targets from natural content, independent of the animated box, and stops on hide', async () => {
  let resized=()=>{}, ready!:()=>void;
  vi.stubGlobal('document',{fonts:{ready:new Promise<void>(resolve=>{ready=resolve;})}});
  vi.stubGlobal('getComputedStyle',()=>({paddingBottom:'14px'}));
  const observed:unknown[]=[], disconnect=vi.fn();
  vi.stubGlobal('ResizeObserver',class { constructor(callback:()=>void) {resized=callback;} observe=(node:unknown)=>observed.push(node); disconnect=disconnect; });
  const preview={offsetTop:54,get offsetHeight(){throw new Error('animated parent must not feed back into its target');}};
  const body={offsetHeight:46}, actions={offsetHeight:28}, setProperty=vi.fn();
  const nodes:Record<string,unknown>={'.island__preview':preview,'.island__content-body':body,'.island__actions':actions};
  const root={querySelector:(selector:string)=>nodes[selector],style:{setProperty}} as unknown as HTMLElement;
  const stop=observeIslandPreviewHeight(root);
  expect(setProperty).toHaveBeenLastCalledWith('--island-open-height','144px');
  expect(observed).toEqual([body,actions]);
  body.offsetHeight=251; resized();
  expect(setProperty).toHaveBeenLastCalledWith('--island-open-height','349px');
  body.offsetHeight=66; ready(); await Promise.resolve();
  expect(setProperty).toHaveBeenLastCalledWith('--island-open-height','164px');
  stop(); expect(disconnect).toHaveBeenCalledOnce(); setProperty.mockClear(); resized();
  expect(setProperty).not.toHaveBeenCalled();
});
