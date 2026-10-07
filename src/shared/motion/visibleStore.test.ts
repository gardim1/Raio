import { afterEach, describe, expect, it, vi } from 'vitest';
import * as stores from './visibleStore';
import { setNativeSurfaceVisible } from './surfaceVisibility';
afterEach(() => { setNativeSurfaceVisible(true); vi.useRealTimers(); });
describe('visible renderer subscriptions', () => {
  it('keeps ingestion current but freezes hidden snapshots and resumes once at the latest value', () => {
    vi.useFakeTimers();
    let value = 0;
    const listeners = new Set<() => void>();
    const store = stores.createVisibleStore((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => value);
    const paint = vi.fn();
    const stop = store.subscribe(paint);
    expect(store.getSnapshot()).toBe(0);
    const feed = setInterval(() => { value++; listeners.forEach(listener => listener()); }, 100);
    vi.advanceTimersByTime(100); expect(paint).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(1);
    setNativeSurfaceVisible(false);
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(value).toBe(11); expect(paint).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(1);
    setNativeSurfaceVisible(true);
    expect(paint).toHaveBeenCalledTimes(2); expect(store.getSnapshot()).toBe(11);
    stop(); clearInterval(feed);
    expect(listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not attach a render subscription when initially hidden', () => {
    setNativeSurfaceVisible(false);
    const subscribe = vi.fn(() => () => {});
    const store = stores.createVisibleStore(subscribe, () => 42);
    const stop = store.subscribe(() => {});
    expect(subscribe).not.toHaveBeenCalled();
    setNativeSurfaceVisible(true); expect(subscribe).toHaveBeenCalledTimes(1);
    stop();
  });
});
