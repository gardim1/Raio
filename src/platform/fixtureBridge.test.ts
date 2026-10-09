import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoGraph } from '../features/architecture/model/demoProject';
import { deriveImportEdges, drawnLinks, isProjectImports } from '../features/project/importEdges';
import { groupInventory } from '../features/project/inventoryGroups';
import { isProjectInventory } from '../features/project/projectInventory';
import { demoSessionLog } from '../features/session/model/demoSession';
import { demoGroupOf, demoImportFacts, demoInventory } from './demoImports';
import { createFixtureBridge, createProjectFixtureBridge, createSimulatedFeedBridge, demoSnapshot, feedArrivals } from './fixtureBridge';

describe('fixture bridge', () => {
  it.each([
    ['static fixture', () => createFixtureBridge()],
    ['simulated feed', () => createSimulatedFeedBridge({ fixedNowMs: 0 })],
    ['project fixture', () => createProjectFixtureBridge()],
    ['outdated project fixture', () => createProjectFixtureBridge({ hooksState: 'outdated' })],
  ])('%s returns the same integration status until it changes', (_name, makeBridge) => {
    const bridge = makeBridge();
    expect(bridge.integrationStatus).toBeTypeOf('function');
    expect(bridge.integrationStatus?.()).toBe(bridge.integrationStatus?.());
  });

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

  it.each([true, false, undefined])('defaults fixture dropped accounting to exact without overriding %s', (flag) => {
    const core = {
      dropped: 3, ...(flag === undefined ? {} : { droppedAtLeast: flag }),
      watcherOverflow: false, historyResetFrom: null, hookBinary: 'raio-hook',
    };
    const bridge = createFixtureBridge({ ...demoSnapshot, core });
    const snapshot = bridge.currentSession();
    expect(snapshot?.core).toEqual({ ...core, droppedAtLeast: flag ?? false });
    expect(bridge.currentSession()).toBe(snapshot);
    expect(core).toEqual({
      dropped: 3, ...(flag === undefined ? {} : { droppedAtLeast: flag }),
      watcherOverflow: false, historyResetFrom: null, hookBinary: 'raio-hook',
    });
  });
});

describe('fixture bridge: import facts', () => {
  it('serves deterministic demo facts in the contract shape, from both fixture bridges', async () => {
    const a = await createFixtureBridge().projectImports();
    expect(isProjectImports(a)).toBe(true);
    expect(a).toEqual(await createFixtureBridge(null).projectImports());
    expect(a).toEqual(await createSimulatedFeedBridge({ fixedNowMs: 0 }).projectImports());
  });

  it("derives exactly the approved concept's relationships (same pairs, same directions), and nothing else", () => {
    const concept = demoGraph.edges.map((e) => `${e.from}->${e.to}`).sort();
    const derived = drawnLinks(deriveImportEdges(demoImportFacts, demoGroupOf).edges).map((l) => `${l.from}->${l.to}`).sort();
    expect(derived).toEqual(concept);
    expect(derived).toContain('auth->api');
    expect(derived).toContain('config->frontend');
    expect(derived).toContain('api->storage');
    expect(derived).not.toContain('payments->storage');
  });

  it('has demo facts whose edges stay among the demo groups, with unresolved packages and self-group imports left out', () => {
    const result = deriveImportEdges(demoImportFacts, demoGroupOf);
    const ids = new Set(demoGraph.nodes.map((n) => n.id));
    expect(result.edges.length).toBeGreaterThanOrEqual(3);
    for (const e of result.edges) expect(ids.has(e.from) && ids.has(e.to) && e.from !== e.to).toBe(true);
    expect(result.unresolved).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });
});

describe('simulated live feed bridge (dev/test only)', () => {
  afterEach(() => vi.useRealTimers());

  it('stays a labelled fixture, with edges only from the demo import facts', () => {
    const snapshot = createSimulatedFeedBridge({ fixedNowMs: 5000 }).currentSession();
    expect(snapshot?.provenance).toBe('fixture');
    expect(snapshot?.simulatedFeed).toBeDefined();
    const derived = deriveImportEdges(demoImportFacts, demoGroupOf);
    expect(snapshot?.graph.edges.map((e) => e.id)).toEqual(drawnLinks(derived.edges).map((e) => `${e.from}->${e.to}`));
    expect(snapshot?.graph.edges.length).toBeGreaterThanOrEqual(3);
    for (const e of snapshot!.graph.edges) {
      expect(snapshot!.graph.nodeById.has(e.from)).toBe(true);
      expect(snapshot!.graph.nodeById.has(e.to)).toBe(true);
    }
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

describe('fixture bridge: project inventory', () => {
  it('serves a deterministic demo inventory in the contract shape, from both fixture bridges', async () => {
    const a = await createFixtureBridge().projectInventory();
    expect(isProjectInventory(a)).toBe(true);
    expect(a).toEqual(demoInventory);
    expect(a).toEqual(await createFixtureBridge(null).projectInventory());
    expect(a).toEqual(await createSimulatedFeedBridge({ fixedNowMs: 0 }).projectInventory());
  });

  it('lists every file the demo import facts scan, and every folder belongs to a system of the demo graph', () => {
    const listed = new Set(demoInventory.files);
    for (const file of demoImportFacts.files) expect(listed.has(file.path), file.path).toBe(true);
    for (const file of demoInventory.files.filter((f) => f.includes('/'))) expect(demoGroupOf(file), file).not.toBeNull();
  });

  it('reads as the demo graph: one area per system, of the same kind', () => {
    const { groups } = groupInventory(demoInventory);
    expect(groups.map((g) => g.kind).sort()).toEqual(demoGraph.nodes.map((n) => n.kind).sort());
    expect(new Set(demoInventory.files.filter((f) => f.includes('/')).map(demoGroupOf))).toEqual(new Set(demoGraph.nodes.map((n) => n.id)));
  });

  it('names technologies from manifests only', () => {
    expect(groupInventory(demoInventory).technologies).toEqual(['Frontend · React', 'API · Express']);
  });
});
