import { describe, expect, it, vi } from 'vitest';
import { expandedWindowChrome } from './ExpandedWindow';

describe('Expanded native chrome selection', () => {
  const api = { close: async () => {}, minimize: async () => {}, toggleMaximize: async () => {}, startDragging: async () => {}, isMaximized: async () => false, onResized: async () => () => {} };
  it('uses the injected window API only for a native Windows Expanded window', () => {
    const getWindow = vi.fn(() => api);
    expect(expandedWindowChrome({ kind: 'native', fixedSurface: 'expanded' }, 'Mozilla Windows NT 10.0', getWindow)).toBe(api);
    expect(getWindow).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['fixture', null, 'Windows NT 10.0'],
    ['fixture', 'expanded', 'Windows NT 10.0'],
    ['native', 'mini', 'Windows NT 10.0'],
    ['native', 'island', 'Windows NT 10.0'],
    ['native', 'expanded', 'Macintosh'],
    ['native', 'expanded', 'Linux'],
  ] as const)('does not touch native windows for %s/%s/%s', (kind, fixedSurface, ua) => {
    const getWindow = vi.fn(() => api);
    expect(expandedWindowChrome({ kind, fixedSurface }, ua, getWindow)).toBeUndefined();
    expect(getWindow).not.toHaveBeenCalled();
  });
});
