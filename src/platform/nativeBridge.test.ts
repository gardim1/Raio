import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { RaioEvent } from '../features/ingest/raioEvent';
import { createNativeBridge, type NativeIpc, surfaceFromUrl } from './nativeBridge';

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
  const calls: [string, unknown][] = [];
  const ipc: NativeIpc = {
    invoke: <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === 'list_projects') return Promise.resolve(projects as T);
      if (command === 'project_events') return Promise.resolve(events as T);
      return Promise.resolve(undefined as T);
    },
    onIngested: (l) => (ingested = l),
    chooseFolder: () => Promise.resolve(null),
  };
  return { ipc, calls, ingest: () => ingested() };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('native bridge', () => {
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
