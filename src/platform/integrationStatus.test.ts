import { describe, expect, it } from 'vitest';
import { createFixtureBridge } from './fixtureBridge';
import { readIntegrationStatus } from './desktopBridge';
import { sidebarFixtureIntegrationStatus } from '../../tests/visual/fixtures/sidebar';

describe('integration status snapshots', () => {
  it('keeps repeated React snapshot reads stable when an adapter returns a fresh object', () => {
    const base = createFixtureBridge(null);
    const bridge = {
      ...base,
      integrationStatus: () => ({ hooks: 'current' as const, hookBinary: true, heartbeatAgeMs: 1_000, inertMarkerAt: null, lastHookEventAt: null, lastHookSessionId: null, lastWatcherChangeAt: null }),
    };
    const first = readIntegrationStatus(bridge);
    expect(readIntegrationStatus(bridge)).toBe(first);
  });

  it('returns a new snapshot when one status field changes', () => {
    const base = createFixtureBridge(null);
    let heartbeatAgeMs = 1_000;
    const bridge = {
      ...base,
      integrationStatus: () => ({ hooks: 'current' as const, hookBinary: true, heartbeatAgeMs, inertMarkerAt: null, lastHookEventAt: null, lastHookSessionId: null, lastWatcherChangeAt: null }),
    };
    const first = readIntegrationStatus(bridge);
    heartbeatAgeMs = 2_000;
    const changed = readIntegrationStatus(bridge);
    expect(changed).not.toBe(first);
    expect(changed?.heartbeatAgeMs).toBe(2_000);
  });

  it('keeps the browser sidebar fixture value stable for each displayed state', () => {
    expect(sidebarFixtureIntegrationStatus('outdated')).toBe(sidebarFixtureIntegrationStatus('outdated'));
    expect(sidebarFixtureIntegrationStatus('outdated')).not.toBe(sidebarFixtureIntegrationStatus('mapped'));
  });
});
