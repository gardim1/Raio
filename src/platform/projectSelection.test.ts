import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import type { ConnectedProject, ConnectPreview } from './desktopBridge';
import type { RaioEvent } from '../features/ingest/raioEvent';

const projects: ConnectedProject[] = [{ id: 'a', name: 'A', root: 'C:/work/A' }, { id: 'b', name: 'B', root: 'C:/work/B' }];
const preview: ConnectPreview = { settingsPath: 'fixture/settings.local.json', before: '{}', after: '{}', gitIgnored: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

const sharedStorage = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  return values;
};
const source = (connect: () => unknown = () => projects[1], list: () => ConnectedProject[] = () => projects) => {
  const broadcasts: string[] = [];
  const ipc: NativeIpc = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === 'list_projects') return list() as T;
      if (command === 'connect_project') return connect() as T;
      if (command === 'project_events') return [{
        schema: 1, id: 'start-' + args?.projectId, kind: 'session.started', projectId: String(args?.projectId),
        sessionId: 'session-' + args?.projectId, agent: 'claude', source: 'claude-hook',
        provenance: 'agent-reported', attribution: 'session', sourceAt: 1000, observedAt: 1000,
        seq: 1, paths: [], evidence: {},
      } satisfies RaioEvent] as T;
      return null as T;
    },
    onIngested: () => {}, chooseFolder: async () => null,
    emitProjectSelected: async root => { broadcasts.push(root); },
  };
  return { ipc, broadcasts };
};

describe('selected project survives native surface creation', () => {
  it.each(['mini', 'island'] as const)('selects B before the first %s exists and never exposes A there', async surface => {
    const values = sharedStorage();
    const expanded = createNativeBridge('expanded', source().ipc, Date.now, 50, []);
    await settle();
    expect(expanded.connector!.project()?.id).toBe('a');
    expect(await expanded.selectProject!('C:/work/B')).toBe(true);
    expect([...values.values()]).toContain('C:/work/B');
    const compact = createNativeBridge(surface, source().ipc, Date.now, 50, []);
    const seen: string[] = [];
    compact.subscribe(() => { const name = compact.currentSession()?.project; if (name) seen.push(name); });
    await settle(); await settle();
    expect(compact.connector!.project()?.id).toBe('b');
    expect(compact.currentSession()?.log.id).toBe('session-b');
    expect(seen).not.toContain('A');
  });
  it('rejects a stale persisted project by falling back to a connected project', async () => {
    sharedStorage();
    const expanded = createNativeBridge('expanded', source().ipc, Date.now, 50, []);
    await settle(); await expanded.selectProject!('C:/work/B');
    const compact = createNativeBridge('mini', source(undefined, () => [projects[0]!]).ipc, Date.now, 50, []);
    await settle();
    expect(compact.connector!.project()?.id).toBe('a');
  });
  it('keeps ordinary selection usable when renderer storage is unavailable', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('unavailable'); }, setItem: () => { throw Error('unavailable'); } });
    const feed = source();
    const expanded = createNativeBridge('expanded', feed.ipc, Date.now, 50, []);
    await settle();
    expect(await expanded.selectProject!('C:/work/B')).toBe(true);
    expect(expanded.connector!.project()?.id).toBe('b');
    expect(feed.broadcasts).toEqual(['C:/work/B']);
  });
});

describe('Core-confirmed connected root identity', () => {
  it('uses the canonical Core result for selection, storage and broadcast instead of a junction-like submitted alias', async () => {
    const values = sharedStorage();
    const canonical = { id: 'b', name: 'B', root: 'D:/canonical/B' };
    const feed = source(() => canonical, () => [projects[0]!, canonical]);
    const expanded = createNativeBridge('expanded', feed.ipc, Date.now, 50, []);
    await settle();
    await expanded.connector!.connect('C:/junction-to-B', preview);
    expect(expanded.connector!.project()).toEqual(canonical);
    expect(feed.broadcasts).toEqual(['D:/canonical/B']);
    expect([...values.values()]).toContain('D:/canonical/B');
    expect([...values.values()]).not.toContain('C:/junction-to-B');
    const compact = createNativeBridge('mini', source(undefined, () => [projects[0]!, canonical]).ipc, Date.now, 50, []);
    await settle();
    expect(compact.connector!.project()).toEqual(canonical);
  });
  it('matches a legacy connected root ending in /. to a canonical folder intent', async () => {
    sharedStorage();
    const legacy = { ...projects[1]!, root: 'C:/work/B/.' };
    const expanded = createNativeBridge('expanded', source(undefined, () => [projects[0]!, legacy]).ipc, Date.now, 50, []);
    await settle();
    expect(await expanded.selectProject!('c:\\WORK\\b')).toBe(true);
    expect(expanded.connector!.project()?.id).toBe('b');
    const mini = createNativeBridge('mini', source().ipc, Date.now, 50, []);
    await settle();
    expect(mini.connector!.project()?.id).toBe('b');
  });
});


it('does not let an older project list replace Core-confirmed B during Connect', async () => {
  sharedStorage();
  let connected = false;
  const feed = source(() => { connected = true; return projects[1]; }, () => connected ? projects : [projects[0]!]);
  const invoke = feed.ipc.invoke;
  let release: (() => void) | undefined;
  let first = true;
  feed.ipc.invoke = <T,>(command: string, args?: Record<string, unknown>) => {
    const result = invoke<T>(command, args);
    if (command !== 'list_projects' || !first) return result;
    first = false;
    return new Promise<T>(resolve => { release = () => { void result.then(resolve); }; });
  };
  const expanded = createNativeBridge('expanded', feed.ipc, Date.now, 50, []);
  await settle();
  expect(release).toBeTypeOf('function');
  const connecting = expanded.connector!.connect('C:/work/B', preview);
  await settle();
  release!();
  await connecting;
  await settle();
  expect(expanded.connector!.project()?.id).toBe('b');
  expect(expanded.currentSession()?.log.id).toBe('session-b');
  expect(feed.broadcasts).toEqual(['C:/work/B']);
});
