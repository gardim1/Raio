import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { ConnectionFooter } from '../features/panel/ConnectionFooter';
import { BridgeProvider } from './BridgeContext';
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import { createFixtureBridge, createProjectFixtureBridge, createSimulatedFeedBridge } from './fixtureBridge';

const OUTDATED = "Raio's hooks for this project are out of date — reconnect to capture PowerShell checks.";
const project = { id: 'p1', name: 'acme', root: 'C:/work/acme' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.useRealTimers());
const feed = (read: () => Promise<unknown>) => {
  let current: typeof project | null = project;
  let notify: () => void = () => {};
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const ipc: NativeIpc = {
    invoke: <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, ...(args ? { args } : {}) });
      if (command === 'list_projects') return Promise.resolve((current ? [current] : []) as T);
      if (command === 'project_events') return Promise.resolve([] as T);
      if (command === 'project_hooks_state') return read() as Promise<T>;
      if (command === 'disconnect_project') current = null;
      if (command === 'connect_project') current = project;
      if (command === 'preview_connect') return Promise.resolve({ settingsPath: 'fixture/settings.local.json', before: '{}', after: '{"hooks":{}}', gitIgnored: true } as T);
      return Promise.resolve(undefined as T);
    },
    onIngested: (listener) => (notify = listener),
    chooseFolder: () => Promise.resolve(null),
  };
  return { ipc, calls, notify: () => notify(), setProject: (value: typeof project | null) => (current = value) };
};
const render = (bridge: ReturnType<typeof createNativeBridge>) => renderToStaticMarkup(createElement(BridgeProvider, {
  bridge, children: createElement(ConnectionFooter, { connector: bridge.connector! }),
})).replaceAll('&#x27;', "'");

describe('read-only project hook version', () => {
  it.each([
    { name: 'current', read: () => Promise.resolve('current'), state: 'current', warn: false },
    { name: 'outdated', read: () => Promise.resolve('outdated'), state: 'outdated', warn: true },
    { name: 'unknown', read: () => Promise.resolve('unknown'), state: 'unknown', warn: false },
    { name: 'command error', read: () => Promise.reject(new Error('cannot read')), state: 'unknown', warn: false },
    { name: 'older core missing command', read: () => Promise.reject(new Error('unknown command')), state: 'unknown', warn: false },
    { name: 'malformed reply', read: () => Promise.resolve({ state: 'outdated' }), state: 'unknown', warn: false },
  ])('handles $name without automatically rewriting settings', async ({ read, state, warn }) => {
    const fake = feed(read);
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 1000, []);
    await settle();
    await settle();
    expect(fake.calls).toContainEqual({ command: 'project_hooks_state', args: { projectId: 'p1' } });
    expect(bridge.projectHooksState?.()).toBe(state);
    expect(render(bridge).includes(OUTDATED)).toBe(warn);
    expect(render(bridge).includes('>Reconnect</button>')).toBe(warn);
    expect(fake.calls.some(({ command }) => ['connect_project', 'disconnect_project', 'preview_connect'].includes(command))).toBe(false);
  });

  it('refreshes on a coarse interval and after explicit preview/connect, not on event notifications', async () => {
    vi.useFakeTimers();
    let state = 'outdated';
    const fake = feed(() => Promise.resolve(state));
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 1000, []);
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.calls.filter(({ command }) => command === 'project_hooks_state').length;
    state = 'current';
    fake.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.projectHooksState?.()).toBe('outdated');
    expect(fake.calls.filter(({ command }) => command === 'project_hooks_state')).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.projectHooksState?.()).toBe('current');
    expect(render(bridge)).not.toContain(OUTDATED);
    expect(fake.calls.filter(({ command }) => command === 'project_hooks_state').length).toBeGreaterThan(before);
    const preview = await bridge.connector!.preview(project.root);
    expect(fake.calls.some(({ command }) => command === 'connect_project')).toBe(false);
    await bridge.connector!.connect(project.root, preview);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toContainEqual({ command: 'connect_project', args: { root: project.root, previewed: preview } });
    expect(bridge.projectHooksState?.()).toBe('current');
  });

  it('reads once through an event burst, then forces a new read when connecting the same project', async () => {
    const fake = feed(() => Promise.resolve('current'));
    const bridge = createNativeBridge('island', fake.ipc, Date.now, 1000, []);
    await settle();
    for (let i = 0; i < 20; i++) { fake.notify(); await settle(); }
    expect(fake.calls.filter(({ command }) => command === 'project_hooks_state')).toHaveLength(1);
    const preview = await bridge.connector!.preview(project.root);
    await bridge.connector!.connect(project.root, preview);
    await settle();
    expect(fake.calls.filter(({ command }) => command === 'project_hooks_state')).toHaveLength(2);
  });

  it('applies the pending current-project answer despite subsequent event bursts', async () => {
    const replies: ((value: unknown) => void)[] = [];
    const fake = feed(() => new Promise((resolve) => replies.push(resolve)));
    const bridge = createNativeBridge('island', fake.ipc, Date.now, 1000, []);
    await settle();
    for (let i = 0; i < 8; i++) { fake.notify(); await settle(); }
    replies[0]!('outdated');
    await settle();
    expect(bridge.projectHooksState?.()).toBe('outdated');
    expect(render(bridge)).toContain(OUTDATED);
  });

  it('reads immediately when the connected project root changes', async () => {
    let state = 'outdated';
    const fake = feed(() => Promise.resolve(state));
    const bridge = createNativeBridge('island', fake.ipc, Date.now, 1000, []);
    await settle();
    state = 'current';
    fake.setProject({ ...project, root: 'C:/work/other' });
    fake.notify();
    await settle();
    expect(bridge.projectHooksState?.()).toBe('current');
    expect(fake.calls.filter(({ command }) => command === 'project_hooks_state')).toHaveLength(2);
  });

  it('does not read a disconnected project or retain its warning', async () => {
    const fake = feed(() => Promise.resolve('outdated'));
    fake.setProject(null);
    const bridge = createNativeBridge('expanded', fake.ipc, Date.now, 1000, []);
    await settle();
    expect(fake.calls.some(({ command }) => command === 'project_hooks_state')).toBe(false);
    expect(bridge.projectHooksState?.()).toBe('unknown');
    fake.setProject(project);
    fake.notify();
    await settle();
    await settle();
    expect(render(bridge)).toContain(OUTDATED);
    await bridge.connector!.disconnect();
    expect(bridge.projectHooksState?.()).toBe('unknown');
    expect(render(bridge)).toBe('');
  });

  it('ignores a late reply for the previous project', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const fake = feed(() => new Promise((resolve) => (resolveOld = resolve)));
    const bridge = createNativeBridge('island', fake.ipc, Date.now, 1000, []);
    await settle();
    expect(fake.calls).toContainEqual({ command: 'project_hooks_state', args: { projectId: 'p1' } });
    fake.setProject(null);
    fake.notify();
    await settle();
    resolveOld('outdated');
    await settle();
    expect(bridge.connector!.project()).toBeNull();
    expect(bridge.projectHooksState?.()).toBe('unknown');
  });

  it('lets the project map render while an optional hook query is pending, then reports unknown on timeout', async () => {
    const fake = feed(() => new Promise(() => {}));
    const bridge = createNativeBridge('island', fake.ipc, Date.now, 20, []);
    await settle();
    expect(bridge.connector!.project()?.id).toBe('p1');
    expect(bridge.currentProjectMap()?.project.id).toBe('p1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.projectHooksState?.()).toBe('unknown');
  });

  it('defaults all fixture bridges to current without native IPC', () => {
    for (const bridge of [createFixtureBridge(), createProjectFixtureBridge(), createSimulatedFeedBridge({ fixedNowMs: 0 })]) {
      expect(bridge.projectHooksState?.()).toBe('current');
    }
  });

  it('offers a labelled fixture review without changing hook state until explicit connect', async () => {
    const bridge = createProjectFixtureBridge({ hooksState: 'outdated' });
    expect(bridge.projectHooksState?.()).toBe('outdated');
    expect(render(bridge)).toContain(OUTDATED);
    const root = bridge.connector!.project()!.root;
    const preview = await bridge.connector!.preview(root);
    expect(preview.before).toContain('Bash');
    expect(preview.after).toContain('PowerShell');
    expect(bridge.projectHooksState?.()).toBe('outdated');
    await bridge.connector!.connect(root, preview);
    expect(bridge.projectHooksState?.()).toBe('current');
    expect(render(bridge)).not.toContain(OUTDATED);
    await bridge.connector!.disconnect();
    expect(bridge.connector!.project()).toBeNull();
    expect(bridge.currentProjectMap()).toBeNull();
  });
});
