import { describe, expect, it } from 'vitest';
import { createFixtureBridge, demoSnapshot } from './fixtureBridge';

describe('fixture bridge', () => {
  it('serves the demo session labelled as a fixture', () => {
    const bridge = createFixtureBridge();
    expect(bridge.kind).toBe('fixture');
    expect(bridge.currentSession()?.provenance).toBe('fixture');
  });

  it('can represent "no project" without inventing data', () => {
    expect(createFixtureBridge(null).currentSession()).toBeNull();
  });

  it('refuses to pass off live data as a fixture', () => {
    expect(() => createFixtureBridge({ ...demoSnapshot, provenance: 'live' })).toThrow();
  });
});
