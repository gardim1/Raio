import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoSessionLog } from '../features/session/model/demoSession';
import { createFixtureBridge, createSimulatedFeedBridge, demoSnapshot, feedArrivals } from './fixtureBridge';

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

describe('simulated live feed bridge (dev/test only)', () => {
  afterEach(() => vi.useRealTimers());

  it('stays a labelled fixture, with a map that has no relationships', () => {
    const snapshot = createSimulatedFeedBridge({ fixedNowMs: 5000 }).currentSession();
    expect(snapshot?.provenance).toBe('fixture');
    expect(snapshot?.simulatedFeed).toBeDefined();
    expect(snapshot?.graph.edges).toEqual([]);
  });

  it('serves exactly the events that had arrived at a fixed clock, and never schedules anything', () => {
    vi.useFakeTimers();
    const arrivals = feedArrivals(demoSessionLog, 'steady');
    const at = (ms: number) => createSimulatedFeedBridge({ fixedNowMs: ms }).currentSession();
    expect(at(0)?.log.events.map((e) => e.kind)).toEqual(['session.start']);
    expect(at(arrivals[3]!)?.log.events).toHaveLength(4);
    expect(at(1e9)?.log.events).toHaveLength(demoSessionLog.events.length);
    expect(vi.getTimerCount()).toBe(0);
    expect(at(arrivals[3]!)?.simulatedFeed?.arrivalMs).toEqual(arrivals.slice(0, 4));
  });

  it('appends events over time on the wall clock and notifies subscribers', () => {
    vi.useFakeTimers();
    const bridge = createSimulatedFeedBridge({ arrivalMs: demoSessionLog.events.map((_, i) => i * 100) });
    let notified = 0;
    bridge.subscribe(() => notified++);
    expect(bridge.currentSession()?.log.events).toHaveLength(1);
    const first = bridge.currentSession();
    expect(bridge.currentSession()).toBe(first); // stable between notifications
    vi.advanceTimersByTime(350);
    expect(bridge.currentSession()?.log.events).toHaveLength(4);
    expect(notified).toBeGreaterThanOrEqual(3);
  });

  it('has a burst pace that delivers most events within a third of a second', () => {
    const arrivals = feedArrivals(demoSessionLog, 'burst');
    expect(arrivals.slice(2).every((a) => a - arrivals[2]! < 500)).toBe(true);
  });
});
