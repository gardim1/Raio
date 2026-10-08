import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { HEURISTIC_NOTE } from '../features/project/classifyPath';
import type { RaioEvent } from '../features/ingest/raioEvent';
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import { deriveSidebarState } from '../features/panel/sidebarState';

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

const SESSION = (): RaioEvent[] => [
  event(1, 'session.started'),
  event(2, 'file.edit.reported', { paths: ['src/auth/login.ts'] }),
  event(3, 'file.edit.reported', { paths: ['src/api/x.ts'] }),
];

const INVENTORY = {
  files: ['package.json', 'src/auth/login.ts', 'src/api/x.ts', 'src/web/app.tsx', 'src/payments/charge.ts'],
  truncated: false,
  skipped: 0,
  scannedAtMs: 5,
  manifests: [{ path: 'package.json', kind: 'npm', facts: { dependencies: ['express'] } }],
};
const SCAN = {
  files: [
    { path: 'src/api/x.ts', specifiers: ['../auth/login'] },
    { path: 'src/auth/login.ts', specifiers: [] },
    { path: 'src/web/app.tsx', specifiers: ['../api/x'] },
  ],
  truncated: false,
  skipped: 0,
  scannedAtMs: 5,
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An ipc whose `project_inventory` (and `project_imports`) answers are under the test's control. */
const fakeIpc = (options: { events: () => RaioEvent[]; inventory: () => Promise<unknown>; imports?: () => Promise<unknown>; projects?: () => unknown[] }) => {
  let ingested: () => void = () => {};
  const calls: [string, unknown][] = [];
  const ipc: NativeIpc = {
    invoke: <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === 'list_projects') return Promise.resolve((options.projects?.() ?? [project]) as T);
      if (command === 'project_events') return Promise.resolve(options.events() as T);
      if (command === 'project_inventory') return options.inventory() as Promise<T>;
      if (command === 'project_imports') return (options.imports ? options.imports() : Promise.resolve(undefined)) as Promise<T>;
      return Promise.resolve(undefined as T);
    },
    onIngested: (l) => (ingested = l),
    chooseFolder: () => Promise.resolve(null),
  };
  return { ipc, calls, ingest: () => ingested() };
};
const inventoryCalls = (calls: [string, unknown][]) => calls.filter(([c]) => c === 'project_inventory');
const nodeIds = (graph: { nodes: readonly { id: string }[] } | undefined) => graph?.nodes.map((n) => n.id).sort();

afterEach(() => vi.restoreAllMocks());

describe('native bridge: project inventory', () => {
  it('maps the whole project from the inventory the core reports, with dormant untouched areas and hints', async () => {
    const fake = fakeIpc({ events: SESSION, inventory: () => Promise.resolve(INVENTORY) });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    await settle();
    const snapshot = bridge.currentSession();
    expect(nodeIds(snapshot?.graph)).toEqual(['api', 'auth', 'config', 'payments', 'web']);
    expect(snapshot?.graph.nodeById.get('api')?.hint).toBe('API · Express');
    expect(snapshot?.evidence?.note).toMatch(/^Areas are a heuristic guess from folders and manifests/);
    expect(fake.calls).toContainEqual(['project_inventory', { projectId: 'p1' }]);
  });

  it('shows the session first with the areas it touched, then adds the rest of the project', async () => {
    let release: (value: unknown) => void = () => {};
    const fake = fakeIpc({ events: SESSION, inventory: () => new Promise((resolve) => (release = resolve)) });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    expect(bridge.currentSession()?.evidence?.note).toBe(HEURISTIC_NOTE);
    release(INVENTORY);
    await settle();
    await settle();
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);
  });

  it('falls back to the areas the session touched, invents nothing and never crashes when the command is missing, fails or answers something else', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const inventory of [() => Promise.reject(new Error('unknown command')), () => Promise.resolve({ files: 'x' }), () => Promise.resolve(undefined), () => Promise.resolve({ ...INVENTORY, files: ['/home/me/x.ts'] })]) {
      const bridge = createNativeBridge('expanded', fakeIpc({ events: SESSION, inventory }).ipc);
      await settle();
      await settle();
      const snapshot = bridge.currentSession();
      expect(nodeIds(snapshot?.graph)).toEqual(['api', 'auth']);
      expect(snapshot?.evidence?.note).toBe(HEURISTIC_NOTE);
    }
    expect(consoleError).toHaveBeenCalled();
  });

  it('reports a failing inventory once, not on every refresh', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = SESSION();
    const fake = fakeIpc({ events: () => events, inventory: () => Promise.reject(new Error('unknown command')) });
    createNativeBridge('expanded', fake.ipc);
    await settle();
    await settle();
    for (let i = 0; i < 3; i++) {
      events.push(event(10 + i, 'file.changed', { paths: ['src/api/x.ts'], source: 'fs-watch', attribution: 'unassigned', sessionId: undefined }));
      fake.ingest();
      await settle();
    }
    const reported = consoleError.mock.calls.filter(([message]) => String(message).includes('project_inventory'));
    expect(reported).toHaveLength(1);
  });

  it('gives up on an inventory that has not answered in time, and ignores its late answer', async () => {
    let release: (value: unknown) => void = () => {};
    const fake = fakeIpc({ events: SESSION, inventory: () => new Promise((resolve) => (release = resolve)) });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 10);
    await settle();
    await later(30);
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    release(INVENTORY);
    await settle();
    await settle();
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    await expect(bridge.projectInventory()).resolves.toBeNull();
  });

  it('draws the static import edges between the areas of the whole project', async () => {
    const fake = fakeIpc({ events: SESSION, inventory: () => Promise.resolve(INVENTORY), imports: () => Promise.resolve(SCAN) });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    await settle();
    await settle();
    expect(bridge.currentSession()?.graph.edges.map((e) => e.id).sort()).toEqual(['api->auth', 'web->api']);
  });

  it('asks only on the surfaces that draw the map', async () => {
    const island = fakeIpc({ events: SESSION, inventory: () => Promise.resolve(INVENTORY) });
    createNativeBridge('island', island.ipc);
    const mini = fakeIpc({ events: SESSION, inventory: () => Promise.resolve(INVENTORY) });
    createNativeBridge('mini', mini.ipc);
    await settle();
    await settle();
    expect(inventoryCalls(island.calls)).toHaveLength(0);
    expect(inventoryCalls(mini.calls)).toHaveLength(1);
  });

  it('hands out the cached inventory through the bridge without asking again: null until there is one', async () => {
    const fake = fakeIpc({ events: SESSION, inventory: () => Promise.resolve(INVENTORY) });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await expect(bridge.projectInventory()).resolves.toBeNull();
    await settle();
    await settle();
    await expect(bridge.projectInventory()).resolves.toEqual(INVENTORY);
    await bridge.projectInventory();
    expect(inventoryCalls(fake.calls)).toHaveLength(1);
    const failing = createNativeBridge('expanded', fakeIpc({ events: SESSION, inventory: () => Promise.reject(new Error('boom')) }).ipc);
    await settle();
    await settle();
    await expect(failing.projectInventory()).resolves.toBeNull();
  });

  it('forgets the inventory when the connected project changes', async () => {
    let projects: unknown[] = [project];
    let events = SESSION();
    const second = { id: 'p2', name: 'other', root: 'C:/work/other' };
    const fake = fakeIpc({ events: () => events, inventory: () => (projects[0] === project ? Promise.resolve(INVENTORY) : new Promise(() => {})), projects: () => projects });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await settle();
    await settle();
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);
    projects = [second];
    events = SESSION().map((e) => ({ ...e, projectId: 'p2' }));
    fake.ingest();
    await settle();
    await settle();
    expect(bridge.currentSession()?.project).toBe('other');
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    await expect(bridge.projectInventory()).resolves.toBeNull();
  });
});

describe('native bridge: relisting the project', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  /** Lets pending promises settle, then moves the (fake) clock forward. */
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  };

  it('retries a failed listing without any file activity, after 30 s and then 5 min, and then keeps what it has', async () => {
    let attempts = 0;
    const fake = fakeIpc({ events: SESSION, inventory: () => (++attempts < 3 ? Promise.reject(new Error('unknown command')) : Promise.resolve(INVENTORY)) });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await advance(0);
    expect(attempts).toBe(1);
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    await advance(29_999);
    expect(attempts).toBe(1);
    await advance(1);
    expect(attempts).toBe(2);
    await advance(299_999);
    expect(attempts).toBe(2);
    await advance(1);
    expect(attempts).toBe(3);
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);

    let always = 0;
    const failing = fakeIpc({ events: SESSION, inventory: () => (++always, Promise.reject(new Error('boom'))) });
    createNativeBridge('expanded', failing.ipc);
    await advance(3_600_000);
    expect(always).toBe(3);
  });

  it('retries a listing that timed out, and ignores the late answer of the first one', async () => {
    let attempts = 0;
    let releaseFirst: (value: unknown) => void = () => {};
    const fake = fakeIpc({
      events: SESSION,
      inventory: () => (++attempts === 1 ? new Promise((resolve) => (releaseFirst = resolve)) : Promise.resolve(INVENTORY)),
    });
    const bridge = createNativeBridge('expanded', fake.ipc);
    await advance(4_999);
    expect(attempts).toBe(1);
    await advance(1); // gives up on the first listing
    expect(nodeIds(bridge.currentSession()?.graph)).toEqual(['api', 'auth']);
    await advance(30_000);
    expect(attempts).toBe(2);
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);
    releaseFirst({ ...INVENTORY, files: ['only/one.ts'] });
    await advance(0);
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);
  });

  it('labels the areas as of the last listing when a relisting fails, and clears the label when a retry works', async () => {
    let now = 0;
    const events = SESSION();
    let calls = 0;
    const fake = fakeIpc({ events: () => events, inventory: () => (++calls === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(INVENTORY)) });
    const bridge = createNativeBridge('expanded', fake.ipc, () => now);
    await advance(0);
    expect(bridge.currentSession()?.evidence?.note).not.toContain('relisting');
    events.push(event(10, 'file.changed', { paths: ['src/api/x.ts'], source: 'fs-watch', attribution: 'unassigned', sessionId: undefined }));
    now = 20_000;
    fake.ingest();
    await advance(0);
    expect(calls).toBe(2);
    expect(bridge.currentSession()?.evidence?.note).toContain('The latest relisting failed, so these areas are as of the last listing.');
    expect(nodeIds(bridge.currentSession()?.graph)).toHaveLength(5);
    await advance(30_000);
    expect(calls).toBe(3);
    expect(bridge.currentSession()?.evidence?.note).not.toContain('relisting');
  });

  it('restarts the bounded retries when file activity asks again', async () => {
    let now = 0;
    const events = SESSION();
    let calls = 0;
    const fake = fakeIpc({ events: () => events, inventory: () => (++calls, Promise.reject(new Error('boom'))) });
    createNativeBridge('expanded', fake.ipc, () => now);
    await advance(400_000);
    expect(calls).toBe(3);
    events.push(event(10, 'file.changed', { paths: ['src/api/x.ts'], source: 'fs-watch', attribution: 'unassigned', sessionId: undefined }));
    now = 400_000;
    fake.ingest();
    await advance(0);
    expect(calls).toBe(4);
    await advance(30_000);
    expect(calls).toBe(5);
  });

  it('stops retrying for a project that is no longer connected', async () => {
    let projects: unknown[] = [project];
    let calls = 0;
    const fake = fakeIpc({ events: SESSION, inventory: () => (++calls, Promise.reject(new Error('boom'))), projects: () => projects });
    createNativeBridge('expanded', fake.ipc);
    await advance(0);
    expect(calls).toBe(1);
    projects = [];
    fake.ingest();
    await advance(600_000);
    expect(calls).toBe(1);
  });
});

describe('native bridge: listing failure reasons', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());
  const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  const failures = [
    { error: '  Access is denied. (os error 5)  ', expected: 'Access is denied. (os error 5)' },
    { error: new Error('permission denied (os error 13)'), expected: 'permission denied (os error 13)' },
    { error: 'os error 5', expected: 'os error 5' },
    { error: '  Inventory command unavailable  ', expected: 'Inventory command unavailable' },
    { error: 'Read/write failure for relative/path.ts', expected: 'Read/write failure for relative/path.ts' },
    { error: 'Cannot list "C:\\Users\\Fixture Person\\ação project": Access is denied. (os error 5)', expected: 'Cannot list "[folder]": Access is denied. (os error 5)' },
    { error: 'Cannot read C:/Users/Other Person/private: device offline', expected: 'Cannot read [folder]: device offline' },
    { error: 'Cannot read "/home/other person/private": permission denied', expected: 'Cannot read "[folder]": permission denied' },
    { error: 'Cannot read \\\\server\\personal share\\private: device offline', expected: 'Cannot read [folder]: device offline' },
    { error: 'Cannot read file:///C:/Users/Other%20Person/private: device offline', expected: 'Cannot read [folder]: device offline' },
    { error: 'Cannot read /Users/Other Person/private: device offline', expected: 'Cannot read [folder]: device offline' },
    { error: 'Cannot read /home/Private:Secret/data: device offline', expected: 'Cannot read [folder]: device offline' },
    { error: 'Cannot read \\\\?\\C:\\Users\\Private\\data: device offline', expected: 'Cannot read [folder]: device offline' },
    ...["O'Connor", 'Personal, private', 'Personal (private)', 'Personal;private'].map(folder => ({
      error: `Cannot list C:\\Users\\${folder}\\Private Project: Access is denied. (os error 5)`,
      expected: 'Cannot list [folder]: Access is denied. (os error 5)',
    })),
    { error: 'Cannot list "C:\\Users\\O\'Connor\\Private Project": Access is denied', expected: 'Cannot list "[folder]": Access is denied' },
    { error: "Cannot list '/home/O'Connor/Private Project': permission denied", expected: "Cannot list '[folder]': permission denied" },
    { error: "Cannot list '/home/O' Connor/Private Project': permission denied", expected: "Cannot list '[folder]': permission denied" },
    { error: "Cannot list '/home/O',Connor/Private Project': permission denied", expected: "Cannot list '[folder]': permission denied" },
    { error: '', expected: null }, { error: ' \n\t ', expected: null }, { error: new Error(''), expected: null },
    { error: { message: 'private data must not be stringified' }, expected: null },
  ];
  it.each(failures)('forwards a trimmed, path-free reason: $expected', async ({ error, expected }) => {
    const connected = { ...project, root: 'C:/Users/Fixture Person/ação project' };
    const fake = fakeIpc({ events: () => [], projects: () => [connected], inventory: () => Promise.reject(error) });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 5_000, []);
    await advance();
    const map = bridge.currentProjectMap()!;
    expect(map.listing).toBe('unavailable');
    expect(map.listingDetails?.unavailableReason).toBe(expected);
    expect(deriveSidebarState({ snapshot: map }).message).toBe(expected ?? 'The project listing is unavailable.');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/Fixture Person|Other Person|personal share/);
  });

  it('bounds long reasons after redacting paths, without inventing access denial', async () => {
    const fake = fakeIpc({ events: () => [], inventory: () => Promise.reject('Device unavailable: ' + 'x'.repeat(1_000) + ' C:/Users/Private/data') });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 5_000, []);
    await advance();
    const reason = bridge.currentProjectMap()!.listingDetails!.unavailableReason!;
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason).toMatch(/^Device unavailable: x/);
    expect(reason).not.toMatch(/denied|Users|Private/);
  });

  it('clears the reason when a retry succeeds and retains stale-listing semantics on later failure', async () => {
    let attempt = 0, now = 0;
    const events: RaioEvent[] = [];
    const fake = fakeIpc({ events: () => events, inventory: () => ++attempt === 2 ? Promise.resolve(INVENTORY) : Promise.reject('Access is denied. (os error 5)') });
    const bridge = createNativeBridge('expanded', fake.ipc, () => now, 5_000, [30_000]);
    await advance();
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toContain('Access is denied');
    await advance(30_000);
    expect(bridge.currentProjectMap()?.listing).toBe('ready');
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBeNull();
    now = 40_000;
    events.push(event(1, 'file.changed', { sessionId: undefined, source: 'fs-watch', attribution: 'unassigned' }));
    fake.ingest(); await advance();
    expect(bridge.currentProjectMap()?.listingDetails).toMatchObject({ stale: true, unavailableReason: null });
    expect(deriveSidebarState({ snapshot: bridge.currentProjectMap()! }).warnings.join(' ')).toContain('latest relisting failed');
  });

  it('ignores a timed-out rejection after a newer retry has failed differently', async () => {
    let rejectFirst!: (error: unknown) => void, attempt = 0;
    const fake = fakeIpc({ events: () => [], inventory: () => ++attempt === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.reject('Device offline') });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 5_000, [30_000]);
    await advance(5_000);
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBeNull();
    await advance(30_000);
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBe('Device offline');
    rejectFirst('Access is denied. (os error 5)'); await advance();
    fake.ingest(); await advance();
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBe('Device offline');
  });

  it('clears the old reason on project switch and ignores the previous project rejection', async () => {
    let projects = [project], rejectOld!: (error: unknown) => void;
    const fake = fakeIpc({ events: () => [], projects: () => projects, inventory: () => projects[0] === project
      ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.reject('Device offline') });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 5_000, []);
    await advance();
    projects = [{ id: 'other', name: 'Other', root: '/home/synthetic/other' }];
    fake.ingest(); await advance();
    expect(bridge.currentProjectMap()?.project.id).toBe('other');
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBe('Device offline');
    rejectOld('Access is denied. (os error 5)'); await advance();
    fake.ingest(); await advance();
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBe('Device offline');
  });

  it('retires a listing even when selection returns to the same project before its error arrives', async () => {
    let projects = [project], originalAttempts = 0;
    let rejectOld!: (error: unknown) => void, rejectCurrent!: (error: unknown) => void;
    const fake = fakeIpc({ events: () => [], projects: () => projects, inventory: () => projects[0] !== project
      ? Promise.reject('Other folder offline')
      : new Promise((_resolve, reject) => { if (++originalAttempts === 1) rejectOld = reject; else rejectCurrent = reject; }) });
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 5_000, []);
    await advance();
    projects = [{ id: 'other', name: 'Other', root: '/home/synthetic/other' }];
    fake.ingest(); await advance();
    projects = [project]; fake.ingest(); await advance();
    expect(bridge.currentProjectMap()?.listing).toBe('pending');
    rejectOld('Access is denied. (os error 5)'); await advance();
    expect(bridge.currentProjectMap()?.listing).toBe('pending');
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBeNull();
    rejectCurrent('Device offline'); await advance();
    expect(bridge.currentProjectMap()?.listingDetails?.unavailableReason).toBe('Device offline');
  });
});
