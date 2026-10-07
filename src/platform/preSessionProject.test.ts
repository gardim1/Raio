import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { App } from '../app/App';
import type { RaioEvent } from '../features/ingest/raioEvent';
import { useSessionUi } from '../features/session/store/sessionStore';
import { BridgeProvider } from './BridgeContext';
import type { CoreHealth, DesktopBridge } from './desktopBridge';
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import { readProjectMap } from './projectMapBridge';
import { projectMapFrame } from '../features/project/projectMapFrame';
import { createProjectFixtureBridge } from './fixtureBridge';

const project = { id: 'premap', name: 'acme-mini', root: 'C:/work/acme-mini' };
const inventory = { files: ['package.json', 'src/api/a.ts', 'src/auth/a.ts', 'src/web/app.tsx'], manifests: [], truncated: false, skipped: 0, scannedAtMs: 1 };
const imports = { files: [{ path: 'src/web/app.tsx', specifiers: ['../api/a'] }, { path: 'src/api/a.ts', specifiers: [] }], truncated: false, skipped: 0, scannedAtMs: 1 };
// The project map is deliberately separate from currentSession: no SessionLog may be invented.
const projectMapOf = readProjectMap;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const renderApp = (bridge: DesktopBridge) => renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(App) }));

const healthy: CoreHealth = { dropped: 0, watcherOverflow: false, historyResetFrom: null, hookBinary: 'raio-hook' };
const fake = (list: () => Promise<unknown> = () => Promise.resolve(inventory), health: () => Promise<CoreHealth | undefined> = () => Promise.resolve(healthy)) => {
  const events: RaioEvent[] = [];
  let connected = true;
  let notify: () => void = () => {};
  const calls: string[] = [];
  const ipc: NativeIpc = {
    invoke: <T,>(command: string) => {
      calls.push(command);
      if (command === 'core_status') return health() as Promise<T>;
      if (command === 'list_projects') return Promise.resolve((connected ? [project] : []) as T);
      if (command === 'project_events') return Promise.resolve(events as T);
      if (command === 'project_inventory') return list() as Promise<T>;
      if (command === 'project_imports') return Promise.resolve(imports as T);
      if (command === 'disconnect_project') connected = false;
      return Promise.resolve(undefined as T);
    },
    onIngested: (listener) => (notify = listener),
    chooseFolder: () => Promise.resolve(null),
  };
  return { ipc, events, calls, notify: () => notify() };
};

beforeEach(() => useSessionUi.setState({ mode: 'expanded', source: 'live', selectedNodeId: null }));

describe('connected project before its first session', () => {
  it('requests the listing and imports, renders the whole untouched map and makes no session/replay claims', async () => {
    const feed = fake();
    const bridge = createNativeBridge('expanded', feed.ipc, () => 100_000, 1000, []);
    await settle();
    await settle();
    expect(feed.calls).toContain('project_inventory');
    expect(feed.calls).toContain('project_imports');
    expect(bridge.currentSession()).toBeNull();
    const map = projectMapOf(bridge)!;
    expect(map.graph.nodes.map((n) => n.id).sort()).toEqual(['api', 'auth', 'config', 'web']);
    expect(map.graph.edges.map((e) => e.id)).toEqual(['web->api']);
    expect(map).not.toHaveProperty('log');
    const frame = projectMapFrame(map.graph);
    expect([...frame.nodes.values()].every((node) => !node.touched && node.activation === 0 && node.detail === null)).toBe(true);
    expect(frame.ui.validations).toEqual([]);
    expect(frame.ui.finished).toBe(false);
    expect(frame.pulses).toEqual([]);
    expect(frame.risks).toEqual([]);
    const markup = renderApp(bridge);
    expect(markup).toContain('Waiting for an agent session');
    expect(markup).toContain('No session yet');
    expect(markup).toContain('4 systems mapped');
    expect(markup).toContain('Project architecture map');
    expect(markup).toContain('aria-label="Auth"');
    expect(markup).toContain('aria-label="Web"');
    expect(markup).not.toMatch(/Claude Code is working|Unknown agent|Session started|No edits reported|View changes|Replay|files changed|Start a new Claude/);
    expect(markup).not.toContain('Demo fixture');
    feed.notify();
    await settle();
    expect(feed.calls.filter((c) => c === 'project_inventory')).toHaveLength(1);
    expect(feed.calls.filter((c) => c === 'project_imports')).toHaveLength(1);
  });

  it('transitions to the real live session on its first event and to ConnectPanel after disconnect', async () => {
    const feed = fake();
    const bridge = createNativeBridge('expanded', feed.ipc, () => 100_000, 1000, []);
    await settle();
    await settle();
    expect(projectMapOf(bridge)).toBeTruthy();
    const before = projectMapOf(bridge)!.graph;
    feed.events.push({ schema: 1, id: 'real-start', kind: 'session.started', projectId: project.id, sessionId: 'real-session', agent: 'claude', source: 'claude-hook', provenance: 'agent-reported', attribution: 'session', sourceAt: 1000, observedAt: 1000, seq: 1, paths: [], evidence: {} });
    feed.notify();
    await settle();
    expect(bridge.currentSession()?.log.id).toBe('real-session');
    expect(bridge.currentSession()?.graph.nodes.map((node) => node.position)).toEqual(before.nodes.map((node) => node.position));
    expect(projectMapOf(bridge)).toBeNull();
    expect(renderApp(bridge)).not.toContain('Waiting for an agent session');
    await bridge.connector!.disconnect();
    expect(bridge.currentSession()).toBeNull();
    expect(projectMapOf(bridge)).toBeNull();
    const markup = renderApp(bridge);
    expect(markup).toContain('No project yet');
    expect(markup).toContain('Choose a folder');
    expect(markup).not.toContain('Project architecture map');
  });

  it('shows loading while the inventory is pending and an unavailable listing when it fails, without fake areas', async () => {
    let release: (value: unknown) => void = () => {};
    const feed = fake(() => new Promise((resolve) => (release = resolve)));
    const bridge = createNativeBridge('expanded', feed.ipc, () => 100_000, 1000, []);
    await settle();
    expect(projectMapOf(bridge)?.listing).toBe('pending');
    expect(renderApp(bridge)).toContain('Mapping project');
    release(null);
    await settle();
    await settle();
    expect(projectMapOf(bridge)?.listing).toBe('unavailable');
    expect(projectMapOf(bridge)?.graph.nodes).toEqual([]);
    expect(renderApp(bridge)).toContain('Project listing unavailable');
    expect(renderApp(bridge)).not.toContain('0 systems mapped');
  });

  it.each(['mini', 'island'] as const)('keeps the %s surface session-free before telemetry', async (surface) => {
    const feed = fake();
    const bridge = createNativeBridge(surface, feed.ipc, () => 100_000, 1000, []);
    await settle();
    await settle();
    const markup = renderApp(bridge);
    expect(markup).toContain(surface === 'mini' ? 'Project architecture map' : 'Raio · no session');
    if (surface === 'mini') {
      expect(markup).toContain('class="mini__resize"');
      expect(markup).toMatch(/class="mini" style="left:[^;]+;top:/);
    }
    expect(markup).not.toMatch(/View changes|Replay|Session started|files changed/);
    expect(bridge.currentSession()).toBeNull();
  });

  it('keeps the project-only harness visibly separate from real telemetry', () => {
    const bridge = createProjectFixtureBridge();
    expect(bridge.currentSession()).toBeNull();
    expect(bridge.currentProjectMap()?.provenance).toBe('fixture');
    const markup = renderApp(bridge);
    expect(markup).toContain('Demo fixture · not real agent activity');
    expect(markup).toContain('Waiting for an agent session');
    expect(markup).not.toMatch(/View changes|Replay|Session started/);
  });

  it.each(['expanded', 'mini'] as const)('shows missing-hook health instead of waiting on %s', async (surface) => {
    const feed = fake(undefined, () => Promise.resolve({ ...healthy, hookBinary: null }));
    const bridge = createNativeBridge(surface, feed.ipc, () => 100_000, 1000, []);
    await settle();
    await settle();
    expect(renderApp(bridge)).toContain('raio-hook was not found next to Raio; new agent events cannot be recorded.');
    expect(renderApp(bridge)).not.toContain('Waiting for an agent session');
    expect(bridge.currentSession()).toBeNull();
  });

  it.each(['expanded', 'mini'] as const)('does not claim to be waiting when core status is unavailable on %s', async (surface) => {
    let available = true;
    const feed = fake(undefined, () => available ? Promise.resolve(healthy) : Promise.reject(new Error('core unavailable')));
    const bridge = createNativeBridge(surface, feed.ipc, () => 100_000, 1000, []);
    await settle();
    await settle();
    expect(renderApp(bridge)).toContain('Waiting for an agent session');
    available = false;
    feed.notify();
    await settle();
    expect(renderApp(bridge)).toContain('Core status unavailable; new agent events cannot be confirmed.');
    expect(renderApp(bridge)).not.toContain('Waiting for an agent session');
    expect(projectMapOf(bridge)?.graph.nodes).toHaveLength(4);
    available = true;
    feed.notify();
    await settle();
    expect(renderApp(bridge)).toContain('Waiting for an agent session');
  });

  it('marks retained project data unavailable when the core can no longer refresh the connection', async () => {
    const feed = fake();
    const invoke = feed.ipc.invoke;
    let disconnectedCore = false;
    feed.ipc.invoke = <T,>(command: string, args?: Record<string, unknown>) => disconnectedCore && command === 'list_projects'
      ? Promise.reject(new Error('core disconnected')) : invoke<T>(command, args);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bridge = createNativeBridge('expanded', feed.ipc, () => 100_000, 1000, []);
      await settle();
      await settle();
      disconnectedCore = true;
      feed.notify();
      await settle();
      expect(projectMapOf(bridge)?.graph.nodes).toHaveLength(4);
      expect(renderApp(bridge)).toContain('Core status unavailable; new agent events cannot be confirmed.');
      expect(renderApp(bridge)).not.toContain('Waiting for an agent session');
    } finally {
      error.mockRestore();
    }
  });
});
