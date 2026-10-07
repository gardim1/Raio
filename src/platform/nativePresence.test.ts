import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import type { PresenceInput } from '../features/modes/companionPresence';
import { deriveCompanionPresence } from '../features/modes/companionPresence';
import type { RaioEvent } from '../features/ingest/raioEvent';

const event = (seq: number, kind: RaioEvent['kind'], sessionId = 's'): RaioEvent => ({ schema: 1, id: String(seq), projectId: 'p', sessionId, agent: 'claude', source: 'claude-hook', provenance: 'agent-reported', attribution: 'session', observedAt: seq * 1000, seq, kind, paths: ['src/a.ts'], evidence: {} });
const settle = () => new Promise((done) => setTimeout(done, 0));
const fixture = () => {
  let events = [event(1, 'session.started'), event(2, 'file.edit.failed')];
  let healthAvailable = true;
  let ingest = () => {};
  const ipc: NativeIpc = { invoke: async <T,>(command: string) => {
    if (command === 'list_projects') return [{ id: 'p', root: 'C:/fixture', name: 'Fixture' }] as T;
    if (command === 'project_events') return events as T;
    if (command === 'core_status') return (healthAvailable ? { dropped: 0, watcherOverflow: false, historyResetFrom: null, hookBinary: 'fixture' } : undefined) as T;
    return null as T;
  }, onIngested: (receive) => { ingest = receive; }, chooseFolder: async () => null };
  const bridge = createNativeBridge('expanded', ipc, Date.now, 50, []);
  const read = () => (bridge as typeof bridge & { projectPresence?: () => PresenceInput }).projectPresence?.();
  return { bridge, read, newer: () => { events = [...events, event(3, 'session.ended'), event(4, 'session.started', 'new')]; ingest(); }, unavailable: () => { healthAvailable = false; ingest(); } };
};
describe('native presence covers project evidence beyond the replay log', () => {
  it('exposes failed edits even though no successful write entered the session log', async () => {
    const native = fixture(); await settle();
    expect(native.read()).toBeDefined();
    expect(deriveCompanionPresence(native.read()!, 60_000).state).toBe('failure');
    expect(native.bridge.currentSession()?.log.events.some((event) => event.kind === 'file.write')).toBe(false);
  });
  it('keeps older failures available but neutralizes the new session', async () => {
    const native = fixture(); await settle(); native.newer(); await settle();
    expect(native.read()).toBeDefined();
    const result = deriveCompanionPresence(native.read()!, 60_000);
    expect(result.state).toBe('connected');
    expect(result.records[0]?.historical).toBe(true);
  });
  it('reports unavailable core data without deleting the connected project', async () => {
    const native = fixture(); await settle(); native.unavailable(); await settle();
    expect(native.read()).toBeDefined();
    expect(deriveCompanionPresence(native.read()!, 60_000).state).toBe('unknown');
    expect(native.bridge.connector?.project()?.id).toBe('p');
  });
});
