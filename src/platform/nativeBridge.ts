import { invoke } from '@tauri-apps/api/core';
import type { DesktopBridge, Surface } from './desktopBridge';
import { demoSnapshot } from './fixtureBridge';

const SURFACES: readonly Surface[] = ['island', 'mini', 'expanded'];

/** The surface a native window was opened for (`?surface=`). */
export const surfaceFromUrl = (search: string): Surface | null => {
  const s = new URLSearchParams(search).get('surface');
  return SURFACES.find((x) => x === s) ?? null;
};

/**
 * Bridge to the Tauri core. Until the local ingestion path exists (E2E-1) it still serves the
 * labelled demo fixture: the provenance stays 'fixture' so nothing pretends to be real telemetry.
 */
export const createNativeBridge = (fixedSurface: Surface): DesktopBridge => {
  const report = (command: string) => (error: unknown) => console.error(`[raio] ${command} failed`, error);
  return {
    kind: 'native',
    fixedSurface,
    currentSession: () => demoSnapshot,
    subscribe: () => () => {},
    showSurface: (surface, intent) => void invoke('show_surface', { surface, intent: intent ?? null }).catch(report('show_surface')),
    setPinned: (pinned) => void invoke('set_always_on_top', { surface: 'mini', onTop: pinned }).catch(report('set_always_on_top')),
    setIslandHitRect: (rect) => void invoke('set_island_hit_rect', { rect }).catch(report('set_island_hit_rect')),
  };
};
