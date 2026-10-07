import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNativeSurfaceVisible } from '../shared/motion/surfaceVisibility';
import * as effects from './NativeSurfaceEffects';
afterEach(() => { vi.unstubAllGlobals(); setNativeSurfaceVisible(true); vi.useRealTimers(); });
describe('Island graphic measurements', () => {
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
