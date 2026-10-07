import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSurfaceVisible, setNativeSurfaceVisible, subscribeSurfaceVisibility } from './surfaceVisibility';

describe('surface visibility', () => {
  it('follows the native shell signal', () => {
    expect(isSurfaceVisible()).toBe(true);
    setNativeSurfaceVisible(false);
    expect(isSurfaceVisible()).toBe(false);
    setNativeSurfaceVisible(true);
    expect(isSurfaceVisible()).toBe(true);
  });
});

afterEach(() => { vi.unstubAllGlobals(); setNativeSurfaceVisible(true); });
it('sets the CSS pause boundary for an initially hidden page and later page visibility changes', () => {
  let state = 'hidden';
  let changed: (() => void) | undefined;
  const toggle = vi.fn();
  vi.stubGlobal('document', {
    get visibilityState() { return state; },
    documentElement: { classList: { toggle } },
    addEventListener: (_: string, cb: () => void) => { changed = cb; },
    removeEventListener: vi.fn(),
  });
  const stop = subscribeSurfaceVisibility(() => {});
  expect(isSurfaceVisible()).toBe(false);
  expect(toggle).toHaveBeenLastCalledWith('surface-hidden', true);
  state = 'visible'; changed!();
  expect(isSurfaceVisible()).toBe(true);
  expect(toggle).toHaveBeenLastCalledWith('surface-hidden', false);
  stop();
});
