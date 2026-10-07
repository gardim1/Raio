import { useSyncExternalStore } from 'react';

/**
 * Whether this surface is on screen. Combines the page visibility with an explicit signal from
 * the native shell, because a hidden native window may still report `document.visibilityState === 'visible'`.
 * Animation clocks stop while hidden (RAIO_MOTION_SPEC: pause expensive animation when hidden).
 */
let nativeVisible = true;
const listeners = new Set<() => void>();
const notify = () => {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('surface-hidden', !isSurfaceVisible());
  listeners.forEach((l) => l());
};

export const setNativeSurfaceVisible = (visible: boolean): void => {
  if (nativeVisible === visible) return;
  nativeVisible = visible;
  // CSS animations (breathing, shimmer, spinners) keep compositing in a hidden webview; pause them too.
  notify();
};

const pageVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export const isSurfaceVisible = (): boolean => nativeVisible && pageVisible();

export const subscribeSurfaceVisibility = (listener: () => void): (() => void) => {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('surface-hidden', !isSurfaceVisible());
  listeners.add(listener);
  if (listeners.size === 1 && typeof document !== 'undefined') document.addEventListener('visibilitychange', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof document !== 'undefined') document.removeEventListener('visibilitychange', notify);
  };
};

export const useSurfaceVisible = (): boolean => useSyncExternalStore(subscribeSurfaceVisibility, isSurfaceVisible, () => true);
