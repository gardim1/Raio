import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { createNativeBridge, type NativeIpc } from './nativeBridge';
import { createFixtureBridge, createProjectFixtureBridge } from './fixtureBridge';
import { followProjectIntents, sameProjectRoot } from './projectIntent';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const projects = [{ id: 'a', name: 'A', root: 'C:/work/A' }, { id: 'b', name: 'B', root: 'C:/work/B' }];
const inventory = { files: ['package.json', 'src/api/a.ts', 'src/auth/a.ts'], manifests: [], truncated: true, skipped: 2, scannedAtMs: 1 };
const imports = { files: [{ path: 'src/api/a.ts', specifiers: ['../auth/a'] }, { path: 'src/auth/a.ts', specifiers: [] }], truncated: false, skipped: 0, scannedAtMs: 1 };
const fake = (answer: (command: string) => unknown = () => null) => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let intent: (root: string) => void = () => {};
  const ipc: NativeIpc = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'list_projects') return projects as T;
      if (command === 'project_events') return [] as T;
      return answer(command) as T;
    },
    onIngested: () => {}, chooseFolder: async () => null,
    // Optional injected event API is implemented alongside the production bridge interface.
    ...{ onProjectIntent: async (receive: (root: string) => void) => { intent = receive; return () => { if (intent === receive) intent = () => {}; }; } },
  };
  return { ipc, calls, emit: (root: string) => intent(root) };
};

describe('project folder intents', () => {
  it.each([
    ['C:\\Work\\Raio\\', 'c:/work/raio', true, true],
    ['\\\\server\\share\\App', '//SERVER/share/app/', true, true],
    ['C:/work/app', 'C:/work/application', true, false],
    ['/work/App', '/work/app', false, false],
    ['/work/app/', '/work/app', false, true],
  ])('matches %s and %s with Windows=%s', (a, b, windows, expected) => {
    expect(sameProjectRoot(a, b, windows)).toBe(expected);
  });

  it('selects an existing project by normalized root without a connect command', async () => {
    const source = fake();
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    await settle();
    expect(typeof bridge.selectProject).toBe('function');
    expect(await bridge.selectProject?.('c:\\WORK\\b\\')).toBe(true);
    expect(bridge.connector?.project()?.id).toBe('b');
    expect(await bridge.selectProject?.('C:/work/unknown')).toBe(false);
    expect(bridge.connector?.project()?.id).toBe('b');
    expect(source.calls.some(({ command }) => command === 'connect_project')).toBe(false);
  });

  it('takes the startup intent and forwards runtime events, then stops on cleanup', async () => {
    const source = fake((command) => command === 'take_project_intent' ? 'C:/work/new' : null);
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    const received: string[] = [];
    const stop = followProjectIntents(bridge, (root) => received.push(root));
    await settle();
    expect(received).toEqual(['C:/work/new']);
    source.emit('C:/work/second');
    expect(received).toEqual(['C:/work/new', 'C:/work/second']);
    stop();
    source.emit('C:/work/ignored');
    expect(received).toHaveLength(2);
    expect(source.calls).toContainEqual({ command: 'take_project_intent', args: undefined });
  });

  it('survives an effect cleanup/remount while the startup intent is in flight', async () => {
    let resolve: (value: string) => void = () => {};
    const source = fake((command) => command === 'take_project_intent' ? new Promise<string>((done) => { resolve = done; }) : null);
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    const ignored: string[] = [];
    followProjectIntents(bridge, (root) => ignored.push(root))();
    const received: string[] = [];
    const stop = followProjectIntents(bridge, (root) => received.push(root));
    await settle();
    resolve('C:/work/new');
    await settle();
    expect(ignored).toEqual([]);
    expect(received).toEqual(['C:/work/new']);
    expect(source.calls.filter(({ command }) => command === 'take_project_intent')).toHaveLength(1);
    stop();
  });

  it('does not let a late startup response replace a newer runtime intent', async () => {
    let resolve: (value: string) => void = () => {};
    const source = fake((command) => command === 'take_project_intent' ? new Promise<string>((done) => { resolve = done; }) : null);
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    const received: string[] = [];
    const stop = followProjectIntents(bridge, (root) => received.push(root));
    await settle();
    source.emit('C:/work/newer');
    resolve('C:/work/older');
    await settle();
    expect(received).toEqual(['C:/work/newer']);
    stop();
  });

  it.each([null, { root: 'wrong shape' }])('ignores invalid startup replies: %s', async (value) => {
    const source = fake((command) => command === 'take_project_intent' ? value : null);
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    expect(typeof bridge.takeProjectIntent).toBe('function');
    expect(await bridge.takeProjectIntent?.()).toBeNull();
  });

  it('projects a preview using actual inventory/imports, including partial-listing notice', async () => {
    const source = fake((command) => command === 'preview_project_map' ? { inventory, imports } : null);
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    expect(typeof bridge.previewProjectMap).toBe('function');
    const map = await bridge.previewProjectMap?.('C:/work/new');
    expect(map?.graph.edges.map((edge) => edge.id)).toEqual(['api->auth']);
    expect(map?.note).toMatch(/partial|limit|skipped|truncat/i);
    expect(map).not.toHaveProperty('log');
    expect(source.calls).toContainEqual({ command: 'preview_project_map', args: { root: 'C:/work/new' } });
    expect(source.calls.some(({ command }) => command === 'connect_project')).toBe(false);
  });

  it('returns unavailable for an older core or malformed preview response', async () => {
    const source = fake((command) => { if (command === 'preview_project_map' || command === 'take_project_intent') throw new Error('unknown command'); return null; });
    const bridge = createNativeBridge('expanded', source.ipc, Date.now, 50, []);
    expect(typeof bridge.previewProjectMap).toBe('function');
    expect(await bridge.previewProjectMap?.('C:/work/new')).toBeNull();
    expect(await bridge.takeProjectIntent?.()).toBeNull();
    const malformed = createNativeBridge('expanded', fake(() => ({ inventory: {}, imports: {} })).ipc, Date.now, 50, []);
    expect(await malformed.previewProjectMap?.('C:/work/new')).toBeNull();
  });

  it('keeps fixture defaults inert and projects fixture preview data without IPC', async () => {
    const bridge = createFixtureBridge();
    expect(typeof bridge.takeProjectIntent).toBe('function');
    expect(await bridge.takeProjectIntent?.()).toBeNull();
    expect(await bridge.selectProject?.('fixture')).toBe(false);
    expect((await bridge.previewProjectMap?.('fixture'))?.provenance).toBe('fixture');
    const connected = createProjectFixtureBridge({ hooksState: 'current' });
    expect(await connected.selectProject?.('demo-project')).toBe(true);
  });

  it('keeps native Mini on the selected project when Expanded receives a folder intent', async () => {
    const selected = new Set<(root: string) => void>();
    const makeSurface = () => {
      const source = fake();
      return { ...source.ipc,
        onProjectSelected: (receive: (root: string) => void) => { selected.add(receive); },
        emitProjectSelected: async (root: string) => { selected.forEach((receive) => receive(root)); },
      };
    };
    const expanded = createNativeBridge('expanded', makeSurface(), Date.now, 50, []);
    const mini = createNativeBridge('mini', makeSurface(), Date.now, 50, []);
    await settle();
    await expanded.selectProject?.('C:/work/B');
    await settle();
    expect(expanded.connector?.project()?.id).toBe('b');
    expect(mini.connector?.project()?.id).toBe('b');
  });
});
