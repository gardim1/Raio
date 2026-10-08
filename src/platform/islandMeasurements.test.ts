import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNativeSurfaceVisible } from '../shared/motion/surfaceVisibility';
import * as effects from './NativeSurfaceEffects';
import type { Rect } from './desktopBridge';
afterEach(() => { vi.unstubAllGlobals(); setNativeSurfaceVisible(true); vi.useRealTimers(); });
describe('Island graphic measurements', () => {
  it.each([148, 240, 384])('publishes a final open hit box containing the %s px capsule, ignoring spring transforms', width => {
    vi.useFakeTimers();
    let changed = () => {};
    let element = { offsetLeft: (420 - width) / 2, offsetTop: 0, offsetWidth: width, offsetHeight: 36, offsetParent: null,
      getBoundingClientRect: () => { throw new Error('spring geometry must not drive hit testing'); } };
    vi.stubGlobal('document', { querySelector: () => element, body: {}, documentElement: { classList: { toggle: vi.fn() } } });
    class Resize { observe = () => {}; unobserve = () => {}; disconnect = () => {}; }
    class Mutation extends Resize { constructor(callback: () => void) { super(); changed = callback; } }
    vi.stubGlobal('ResizeObserver', Resize); vi.stubGlobal('MutationObserver', Mutation);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const boxes: Rect[] = [];
    const stop = effects.observeIslandHitRect({ setIslandHitRect: rect => boxes.push(rect) }, true);
    vi.advanceTimersByTime(16);
    element = { ...element, offsetLeft: 18, offsetWidth: 384, offsetHeight: 156 };
    changed(); vi.advanceTimersByTime(16);
    const [closed, open] = boxes as [Rect, Rect];
    expect(open).toEqual({ x: 16, y: -2, width: 388, height: 160 });
    expect(open.x).toBeLessThanOrEqual(closed.x);
    expect(open.y).toBeLessThanOrEqual(closed.y);
    expect(open.x + open.width).toBeGreaterThanOrEqual(closed.x + closed.width);
    expect(open.y + open.height).toBeGreaterThanOrEqual(closed.y + closed.height);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it('attaches no observers or frame while hidden', () => {
    const resize = vi.fn(), mutation = vi.fn(), request = vi.fn();
    vi.stubGlobal('ResizeObserver', resize); vi.stubGlobal('MutationObserver', mutation); vi.stubGlobal('requestAnimationFrame', request);
    const stop = effects.observeIslandHitRect({ setIslandHitRect: vi.fn() }, false);
    expect(resize).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    stop();
  });
  it('disconnects layout observers and cancels the queued measurement on hide, then measures current geometry on show', () => {
    vi.useFakeTimers();
    let width = 100;
    const element = { offsetLeft: 4, offsetTop: 6, offsetParent: null, get offsetWidth() { return width; }, offsetHeight: 20 };
    vi.stubGlobal('document', { querySelector: () => element, body: {}, documentElement: { classList: { toggle: vi.fn() } } });
    const disconnect = vi.fn(), observe = vi.fn();
    class Observer { observe = observe; unobserve = vi.fn(); disconnect = disconnect; }
    vi.stubGlobal('ResizeObserver', Observer); vi.stubGlobal('MutationObserver', Observer);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const publish = vi.fn();
    const stop = effects.observeIslandHitRect({ setIslandHitRect: publish }, true);
    expect(vi.getTimerCount()).toBe(1);
    setNativeSurfaceVisible(false);
    vi.advanceTimersByTime(16); expect(publish).not.toHaveBeenCalled();
    stop(); expect(disconnect).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    width = 240; vi.advanceTimersByTime(1000); expect(publish).not.toHaveBeenCalled();
    setNativeSurfaceVisible(true);
    const resume = effects.observeIslandHitRect({ setIslandHitRect: publish }, true);
    vi.advanceTimersByTime(16);
    expect(publish).toHaveBeenCalledWith({ x: 2, y: 4, width: 244, height: 24 });
    resume(); expect(vi.getTimerCount()).toBe(0);
  });
});
