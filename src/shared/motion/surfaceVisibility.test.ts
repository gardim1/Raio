import { describe, expect, it } from 'vitest';
import { isSurfaceVisible, setNativeSurfaceVisible } from './surfaceVisibility';

describe('surface visibility', () => {
  it('follows the native shell signal', () => {
    expect(isSurfaceVisible()).toBe(true);
    setNativeSurfaceVisible(false);
    expect(isSurfaceVisible()).toBe(false);
    setNativeSurfaceVisible(true);
    expect(isSurfaceVisible()).toBe(true);
  });
});
