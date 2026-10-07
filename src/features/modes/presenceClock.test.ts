import { afterEach, describe, expect, it, vi } from 'vitest';
import * as clock from './presenceClock';
import { BOB_TOTAL_SECONDS } from '../raio/bob';
import { isSurfaceVisible, setNativeSurfaceVisible, subscribeSurfaceVisibility } from '../../shared/motion/surfaceVisibility';

afterEach(() => { setNativeSurfaceVisible(true); vi.useRealTimers(); });
describe('presence expiry clock', () => {
  it('expires recent activity once, then leaves quiet presence with no graphic timer', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const seen: string[] = [];
    const stop = clock.runPresenceClock({ input: { connected: true, available: true, facts: [{ id: 'a', kind: 'activity', at: 1000, source: 'fixture' }] }, onChange: value => seen.push(value.state) });
    expect(seen).toEqual(['working']);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(BOB_TOTAL_SECONDS * 1000);
    expect(seen).toEqual(['working', 'connected']);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it('cancels on hide, does no hidden work, and reconciles at current time on show', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const seen: string[] = [];
    const stop = clock.runPresenceClock({ input: { connected: true, available: true, facts: [{ id: 'a', kind: 'activity', at: 1000, source: 'fixture' }] }, onChange: value => seen.push(value.state) });
    setNativeSurfaceVisible(false);
    expect(isSurfaceVisible()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(seen).toEqual(['working']);
    setNativeSurfaceVisible(true);
    expect(seen).toEqual(['working', 'connected']);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it('starts hidden without painting or scheduling, and disposes visibility listeners', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    setNativeSurfaceVisible(false);
    const changed = vi.fn();
    const stop = clock.runPresenceClock({ input: { connected: true, available: true, facts: [] }, onChange: changed });
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    stop(); setNativeSurfaceVisible(true);
    expect(changed).not.toHaveBeenCalled();
    const listener = vi.fn();
    const unsubscribe = subscribeSurfaceVisibility(listener);
    setNativeSurfaceVisible(false); expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); setNativeSurfaceVisible(true); expect(listener).toHaveBeenCalledTimes(1);
  });
});
