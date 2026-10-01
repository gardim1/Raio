import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from '@tauri-apps/api/core';
import { createNativeBridge, surfaceFromUrl } from './nativeBridge';

describe('native bridge', () => {
  it('reads the surface a window was opened for', () => {
    expect(surfaceFromUrl('?surface=island')).toBe('island');
    expect(surfaceFromUrl('?surface=expanded&x=1')).toBe('expanded');
    expect(surfaceFromUrl('?surface=film')).toBeNull();
    expect(surfaceFromUrl('')).toBeNull();
  });

  it('keeps fixture provenance until real ingestion exists', () => {
    expect(createNativeBridge('mini').currentSession()?.provenance).toBe('fixture');
  });

  it('forwards surface changes, pinning and the island hit area to the core', () => {
    const bridge = createNativeBridge('island');
    bridge.showSurface('mini', 'replay');
    bridge.setPinned(false);
    bridge.setIslandHitRect({ x: 1, y: 2, width: 3, height: 4 });
    expect(invoke).toHaveBeenCalledWith('show_surface', { surface: 'mini', intent: 'replay' });
    expect(invoke).toHaveBeenCalledWith('set_always_on_top', { surface: 'mini', onTop: false });
    expect(invoke).toHaveBeenCalledWith('set_island_hit_rect', { rect: { x: 1, y: 2, width: 3, height: 4 } });
  });
});
