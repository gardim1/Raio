import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { RaioEvent } from '../features/ingest/raioEvent';
import { createNativeBridge, type NativeIpc, surfaceFromUrl, takeSurfaceIntent } from './nativeBridge';

const project = { id: 'p1', name: 'acme-mini', root: 'C:/work/acme-mini' };

const event = (seq: number, kind: RaioEvent['kind'], extra: Partial<RaioEvent> = {}): RaioEvent => ({
  schema: 1,
  id: `e${seq}`,
  source: 'claude-hook',
  provenance: 'agent-reported',
  attribution: 'session',
  projectId: 'p1',
  sessionId: 's1',
  agent: 'claude',
  sourceAt: 1_000 + seq * 1_000,
  observedAt: 1_000 + seq * 1_000,
  seq,
  kind,
  paths: [],
  evidence: {},
  ...extra,
});

const fakeIpc = (projects: unknown[], events: RaioEvent[]) => {
  let ingested: () => void = () => {};
  let integration: unknown;
  const calls: [string, unknown][] = [];
  const ipc: NativeIpc = {
    invoke: <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === 'list_projects') return Promise.resolve(projects as T);
      if (command === 'project_events') return Promise.resolve(events as T);
      if (command === 'integration_status') return Promise.resolve(integration as T);
      return Promise.resolve(undefined as T);
    },
    onIngested: (l) => (ingested = l),
    chooseFolder: () => Promise.resolve(null),
  };
  return { ipc, calls, ingest: () => ingested(), setIntegration: (value: unknown) => { integration = value; } };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('native bridge', () => {
  it('caches integration status through refresh and replaces its reference only when the status changes', async () => {
    const fake = fakeIpc([project], []);
    const first = { hooks: 'current', hookBinary: true, heartbeatAgeMs: 1_000, inertMarkerAt: null, lastHookEventAt: null, lastHookSessionId: null, lastWatcherChangeAt: null };
    fake.setIntegration(first);
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    const initial = bridge.integrationStatus?.();
    expect(initial).toEqual(first);
    expect(bridge.integrationStatus?.()).toBe(initial);

    const changed = { ...first, heartbeatAgeMs: 2_000 };
    fake.setIntegration(changed);
    fake.ingest();
    await settle();
    expect(bridge.integrationStatus?.()).toEqual(changed);
    expect(bridge.integrationStatus?.()).not.toBe(initial);
    expect(fake.calls).toContainEqual(['integration_status', { projectId: 'p1' }]);
  });

  it('reads the surface a window was opened for', () => {
    expect(surfaceFromUrl('?surface=island')).toBe('island');
    expect(surfaceFromUrl('?surface=film')).toBeNull();
    expect(surfaceFromUrl('')).toBeNull();
  });

  it('shows nothing (not demo data) when no project is connected', async () => {
    const bridge = createNativeBridge('expanded', fakeIpc([], []).ipc);
    await settle();
    expect(bridge.currentSession()).toBeNull();
    expect(bridge.connector?.project()).toBeNull();
  });

  it('projects the persisted events of the connected project as live data', async () => {
    const fake = fakeIpc([project], [event(1, 'session.started'), event(2, 'file.edit.reported', { paths: ['src/auth/login.ts'], evidence: { change: 'added' } })]);
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    const snapshot = bridge.currentSession();
    expect(snapshot?.provenance).toBe('live');
    expect(snapshot?.project).toBe('acme-mini');
    expect(snapshot?.evidence?.relationships).toBe('unknown');
    expect(fake.calls).toContainEqual(['project_events', { projectId: 'p1' }]);
  });

  it('refreshes when the core reports ingested events and notifies subscribers', async () => {
    const events: RaioEvent[] = [];
    const fake = fakeIpc([project], events);
    const bridge = createNativeBridge('mini', fake.ipc);
    const listener = vi.fn();
    bridge.subscribe(listener);
    await settle();
    expect(bridge.currentSession()).toBeNull();
    events.push(event(1, 'session.started'));
    fake.ingest();
    await settle();
    expect(bridge.currentSession()?.log.events[0]?.kind).toBe('session.start');
    expect(listener).toHaveBeenCalled();
  });

  it('forwards surface changes, pinning and the island hit area to the core', async () => {
    const fake = fakeIpc([], []);
    const bridge = createNativeBridge('island', fake.ipc);
    bridge.showSurface('mini', 'replay');
    bridge.setPinned(false);
    bridge.setIslandHitRect({ x: 1, y: 2, width: 3, height: 4 });
    expect(fake.calls).toContainEqual(['show_surface', { surface: 'mini', intent: 'replay' }]);
    expect(fake.calls).toContainEqual(['set_always_on_top', { surface: 'mini', onTop: false }]);
    expect(fake.calls).toContainEqual(['set_island_hit_rect', { rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  });
});

describe('native bridge refresh', () => {
  it('does not lose a notification that arrives while a refresh is running', async () => {
    const events: RaioEvent[] = [event(1, 'session.started')];
    const fake = fakeIpc([project], events);
    const bridge = createNativeBridge('expanded', fake.ipc);
    events.push(event(2, 'session.ended'));
    fake.ingest(); // arrives while the initial refresh is still in flight
    await settle();
    await settle();
    expect(bridge.currentSession()?.log.events.map((e) => e.kind)).toContain('session.end');
  });
});

describe('native bridge: import edges', () => {
  const SCAN = {
    files: [
      { path: 'src/api/x.ts', specifiers: ['../auth/login', 'zod'] },
      { path: 'src/auth/login.ts', specifiers: [] },
    ],
    truncated: false,
    skipped: 0,
    scannedAtMs: 5,
  };
  const SESSION = () => [event(1, 'session.started'), event(2, 'file.edit.reported', { paths: ['src/auth/login.ts'] }), event(3, 'file.edit.reported', { paths: ['src/api/x.ts'] })];

  /** An ipc whose `project_imports` is under the test's control. */
  const scanIpc = (events: RaioEvent[], scan: () => Promise<unknown>, projects: unknown[] = [project]) => {
    const fake = fakeIpc(projects, events);
    const base = fake.ipc.invoke;
    const ipc: NativeIpc = {
      ...fake.ipc,
      invoke: <T,>(command: string, args?: Record<string, unknown>) => {
        if (command !== 'project_imports') return base<T>(command, args);
        fake.calls.push([command, args]);
        return scan() as Promise<T>;
      },
    };
    return { ...fake, ipc };
  };
  const scans = (calls: [string, unknown][]) => calls.filter(([c]) => c === 'project_imports');

  it('draws the static import edges the core reports and says they are a heuristic', async () => {
    const fake = scanIpc(SESSION(), () => Promise.resolve(SCAN));
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    await settle();
    const snapshot = bridge.currentSession();
    expect(snapshot?.graph.edges.map((e) => e.id)).toEqual(['api->auth']);
    expect(snapshot?.evidence?.relationships).toMatchObject({ kind: 'static-imports', edges: 1, unresolved: 1 });
    expect(snapshot?.evidence?.note).toContain('static imports between areas (heuristic)');
    expect(fake.calls).toContainEqual(['project_imports', { projectId: 'p1' }]);
  });

  it('shows the session before the scan returns, then adds edges without losing it', async () => {
    let release: (value: unknown) => void = () => {};
    const fake = scanIpc(SESSION(), () => new Promise((resolve) => (release = resolve)));
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    expect(bridge.currentSession()?.graph.nodes).toHaveLength(2);
    expect(bridge.currentSession()?.graph.edges).toEqual([]);
    expect(bridge.currentSession()?.evidence?.relationships).toBe('unknown');
    release(SCAN);
    await settle();
    await settle();
    expect(bridge.currentSession()?.graph.edges).toHaveLength(1);
  });

  it('keeps "relationships unknown" and invents nothing when the scan fails or is malformed', async () => {
    for (const scan of [() => Promise.reject(new Error('unknown command')), () => Promise.resolve({ files: 'x' }), () => Promise.resolve(undefined)]) {
      const bridge = createNativeBridge('expanded', scanIpc(SESSION(), scan).ipc);
      await settle();
      await settle();
      const snapshot = bridge.currentSession();
      expect(snapshot?.graph.nodes).toHaveLength(2);
      expect(snapshot?.graph.edges).toEqual([]);
      expect(snapshot?.evidence?.relationships).toBe('unknown');
    }
  });

  it('hands out the cached scan through the bridge, without scanning again: null until there is one', async () => {
    const fake = scanIpc(SESSION(), () => Promise.resolve(SCAN));
    const bridge = createNativeBridge('expanded', fake.ipc);
    await expect(bridge.projectImports()).resolves.toBeNull();
    await settle();
    await settle();
    await expect(bridge.projectImports()).resolves.toEqual(SCAN);
    await bridge.projectImports();
    expect(scans(fake.calls)).toHaveLength(1);
    for (const scan of [() => Promise.reject(new Error('boom')), () => Promise.resolve({ nope: true })]) {
      const failing = createNativeBridge('expanded', scanIpc(SESSION(), scan).ipc);
      await settle();
      await settle();
      await expect(failing.projectImports()).resolves.toBeNull();
    }
    const empty = createNativeBridge('expanded', scanIpc([], () => Promise.resolve(SCAN), []).ipc);
    await settle();
    await expect(empty.projectImports()).resolves.toBeNull();
  });

  it('scans only on the surfaces that draw the map, so one project is not scanned three times', async () => {
    const calls = new Map<string, number>();
    for (const surface of ['island', 'mini', 'expanded'] as const) {
      const fake = scanIpc(SESSION(), () => Promise.resolve(SCAN));
      const bridge = createNativeBridge(surface, fake.ipc);
      await settle();
      await settle();
      calls.set(surface, scans(fake.calls).length);
      if (surface === 'island') {
        expect(bridge.currentSession()?.graph.edges).toEqual([]);
        await expect(bridge.projectImports()).resolves.toBeNull();
      }
    }
    expect(Object.fromEntries(calls)).toEqual({ island: 0, mini: 1, expanded: 1 });
  });

  it('is not blocked by a scan that never answers: it gives up after the timeout and scans again after new activity', async () => {
    const events = SESSION();
    let now = 100_000;
    const answers: (() => Promise<unknown>)[] = [() => new Promise(() => {}), () => Promise.resolve(SCAN)];
    const fake = scanIpc(events, () => answers.shift()!());
    const bridge = createNativeBridge('expanded', fake.ipc, () => now, 20);
    await settle();
    expect(scans(fake.calls)).toHaveLength(1);
    expect(bridge.currentSession()?.evidence?.relationships).toBe('unknown');
    await new Promise((r) => setTimeout(r, 60)); // past the 20 ms timeout
    now += 11_000;
    events.push(event(5, 'file.edit.reported', { paths: ['src/api/y.ts'] }));
    fake.ingest();
    await settle();
    await settle();
    expect(scans(fake.calls)).toHaveLength(2);
    expect(bridge.currentSession()?.graph.edges).toHaveLength(1);
  });

  it('ignores a scan that answers after its timeout', async () => {
    let late: (value: unknown) => void = () => {};
    const fake = scanIpc(SESSION(), () => new Promise((resolve) => (late = resolve)));
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 20);
    await settle();
    await new Promise((r) => setTimeout(r, 60));
    late(SCAN);
    await settle();
    await settle();
    expect(bridge.currentSession()?.graph.edges).toEqual([]);
    expect(bridge.currentSession()?.evidence?.relationships).toBe('unknown');
  });

  it('starts scanning the new project right away when the project changes mid-scan, and drops the old project\'s late answer', async () => {
    const p2 = { id: 'p2', name: 'other', root: 'C:/work/other' };
    let current: typeof project = project;
    const pending = new Map<string, (value: unknown) => void>();
    const calls: [string, unknown][] = [];
    let ingested: () => void = () => {};
    const session = (id: string) => [event(1, 'session.started', { projectId: id }), event(2, 'file.edit.reported', { projectId: id, paths: ['src/auth/login.ts'] }), event(3, 'file.edit.reported', { projectId: id, paths: ['src/api/x.ts'] })];
    const ipc: NativeIpc = {
      invoke: <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        if (command === 'list_projects') return Promise.resolve([current] as T);
        if (command === 'project_events') return Promise.resolve(session(String(args?.projectId)) as T);
        if (command === 'project_imports') return new Promise<T>((resolve) => pending.set(String(args?.projectId), resolve as (value: unknown) => void));
        return Promise.resolve(undefined as T);
      },
      onIngested: (l) => (ingested = l),
      chooseFolder: () => Promise.resolve(null),
    };
    const bridge = createNativeBridge('expanded', ipc);
    await settle();
    expect(pending.has('p1')).toBe(true);
    current = p2;
    ingested();
    await settle();
    expect(pending.has('p2')).toBe(true); // not held back by the unanswered scan of p1
    pending.get('p1')!(SCAN); // the old project answers late
    await settle();
    expect(bridge.currentSession()?.project).toBe('other');
    expect(bridge.currentSession()?.graph.edges).toEqual([]);
    pending.get('p2')!(SCAN);
    await settle();
    await settle();
    expect(bridge.currentSession()?.graph.edges.map((e) => e.id)).toEqual(['api->auth']);
    expect(calls.filter(([c]) => c === 'project_imports')).toEqual([['project_imports', { projectId: 'p1' }], ['project_imports', { projectId: 'p2' }]]);
  });

  it('says the relationships are as of the last scan when a rescan after file activity fails, and clears it when one works', async () => {
    const events = SESSION();
    let now = 100_000;
    const answers: (() => Promise<unknown>)[] = [() => Promise.resolve(SCAN), () => Promise.reject(new Error('boom')), () => Promise.resolve(SCAN)];
    const fake = scanIpc(events, () => answers.shift()!());
    const bridge = createNativeBridge('expanded', fake.ipc, () => now);
    await settle();
    await settle();
    expect(bridge.currentSession()?.evidence?.relationships).toMatchObject({ kind: 'static-imports' });
    expect(bridge.currentSession()?.evidence?.note).not.toMatch(/last scan/);
    now += 11_000;
    events.push(event(5, 'file.edit.reported', { paths: ['src/api/y.ts'] }));
    fake.ingest();
    await settle();
    await settle();
    const stale = bridge.currentSession();
    expect(stale?.graph.edges).toHaveLength(1); // the last good scan still draws
    expect(stale?.evidence?.relationships).toMatchObject({ kind: 'static-imports', stale: true });
    expect(stale?.evidence?.note).toMatch(/as of the last scan/);
    now += 11_000;
    events.push(event(6, 'file.edit.reported', { paths: ['src/api/z.ts'] }));
    fake.ingest();
    await settle();
    await settle();
    expect(bridge.currentSession()?.evidence?.relationships).not.toHaveProperty('stale');
  });

  it('does not scan without a connected project, but scans a connected project before its first session', async () => {
    const noProject = scanIpc([], () => Promise.resolve(SCAN), []);
    createNativeBridge('expanded', noProject.ipc);
    await settle();
    expect(scans(noProject.calls)).toEqual([]);
    const noSession = scanIpc([], () => Promise.resolve(SCAN));
    createNativeBridge('expanded', noSession.ipc);
    await settle();
    expect(scans(noSession.calls)).toEqual([['project_imports', { projectId: 'p1' }]]);
  });

  it('scans once, and again only after new file activity and not more often than every 10 seconds', async () => {
    const events = SESSION();
    let now = 100_000;
    const fake = scanIpc(events, () => Promise.resolve(SCAN));
    createNativeBridge('expanded', fake.ipc, () => now);
    await settle();
    await settle();
    expect(scans(fake.calls)).toHaveLength(1);
    // Events that are not file activity: no new scan.
    events.push(event(4, 'turn.ended'));
    fake.ingest();
    await settle();
    await settle();
    expect(scans(fake.calls)).toHaveLength(1);
    // File activity, but too soon.
    now += 3_000;
    events.push(event(5, 'file.edit.reported', { paths: ['src/api/y.ts'] }));
    fake.ingest();
    await settle();
    await settle();
    expect(scans(fake.calls)).toHaveLength(1);
    // File activity after the interval.
    now += 10_000;
    events.push(event(6, 'file.edit.reported', { paths: ['src/api/z.ts'] }));
    fake.ingest();
    await settle();
    await settle();
    expect(scans(fake.calls)).toHaveLength(2);
  });
});

describe('take_surface_intent', () => {
  const ipcReturning = (value: unknown) => {
    const calls: [string, unknown][] = [];
    const ipc: Pick<NativeIpc, 'invoke'> = {
      invoke: <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return Promise.resolve(value as T);
      },
    };
    return { ipc, calls };
  };

  it('pulls the pending intent with no arguments (the core uses the calling window)', async () => {
    const { ipc, calls } = ipcReturning('replay');
    await expect(takeSurfaceIntent(ipc)).resolves.toBe('replay');
    expect(calls).toEqual([['take_surface_intent', undefined]]);
  });

  it('reports no intent as null', async () => {
    await expect(takeSurfaceIntent(ipcReturning(null).ipc)).resolves.toBeNull();
    await expect(takeSurfaceIntent(ipcReturning(undefined).ipc)).resolves.toBeNull();
  });

  it('ignores a payload that is not a string', async () => {
    await expect(takeSurfaceIntent(ipcReturning({ intent: 'replay' }).ipc)).resolves.toBeNull();
  });

  it('lets an IPC failure reach the caller, which decides how to report it', async () => {
    const ipc: Pick<NativeIpc, 'invoke'> = { invoke: () => Promise.reject(new Error('no such command')) };
    await expect(takeSurfaceIntent(ipc)).rejects.toThrow('no such command');
  });
});
