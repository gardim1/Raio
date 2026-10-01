import type { DesktopBridge } from './desktopBridge';
import { createFixtureBridge } from './fixtureBridge';

/**
 * Chooses the bridge for the product entry. Until the native shell adapter exists,
 * the browser build shows the labelled demo fixture.
 */
export const createBridge = (): DesktopBridge => createFixtureBridge();
