import type { DesktopBridge } from './desktopBridge';
import { createFixtureBridge } from './fixtureBridge';
import { createNativeBridge, surfaceFromUrl } from './nativeBridge';

/** True inside the Tauri webview. */
export const isNativeShell = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Chooses the bridge for the product entry: the native core when running in the shell, else the labelled fixture. */
export const createBridge = (): DesktopBridge => {
  const surface = surfaceFromUrl(window.location.search);
  return isNativeShell() && surface ? createNativeBridge(surface) : createFixtureBridge();
};
