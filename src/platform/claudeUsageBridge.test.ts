import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { createNativeBridge, type NativeIpc } from './nativeBridge';
import { createFixtureBridge } from './fixtureBridge';
const settle = () => new Promise(done => setTimeout(done, 0));
afterEach(() => vi.unstubAllGlobals());
it('fixtures default to disabled, and a product page cannot enable usage demos', () => {
  expect(createFixtureBridge().claudeUsage?.()).toEqual({ status: 'disabled' });
  vi.stubGlobal('location', { pathname: '/index.html', search: '?usage=reading' });
  expect(createFixtureBridge().claudeUsage?.()).toEqual({ status: 'disabled' });
});
it('harness-only demo readings explicitly identify their synthetic source and preserve missing windows', () => {
  vi.stubGlobal('location', { pathname: '/harness.html', search: '?usage=missing-weekly' });
  const state = createFixtureBridge().claudeUsage?.();
  expect(state?.status).toBe('reading');
  if (state?.status === 'reading') {
    expect(state.latest.source.sessionId).toContain('DEMO');
    expect(state.latest.fiveHour?.usedPercentage).toBe(42);
    expect(state.latest.sevenDay).toBeUndefined();
  }
});
it('native usage changes notify subscribers without inventing data on malformed IPC', async () => {
  let usage: unknown = { status: 'waiting' }; let changed = () => {};
  const ipc: NativeIpc = {
    invoke: async <T,>(command: string) => {
      if (command === 'list_projects') return [{ id: 'p', root: 'C:/fixture', name: 'Fixture' }] as T;
      if (command === 'project_events') return [] as T;
      if (command === 'claude_usage') return usage as T;
      return null as T;
    }, onIngested: () => {}, onUsageChanged: (listener: () => void) => { changed = listener; }, chooseFolder: async () => null,
  };
  const bridge = createNativeBridge('island', ipc, Date.now, 50, []); const notified = vi.fn(); bridge.subscribe(notified);
  await settle(); await settle(); expect(bridge.claudeUsage?.()).toEqual({ status: 'waiting' });
  usage = { status: 'incompatible', reason: 'Managed settings prevent an override.' }; changed(); await settle();
  expect(bridge.claudeUsage?.()).toEqual(usage); expect(notified).toHaveBeenCalled();
  usage = { status: 'reading', latest: { fiveHour: { usedPercentage: -1 } }, sourceCount: 1 }; changed(); await settle();
  expect(bridge.claudeUsage?.()?.status).toBe('error');
});

it('a late usage response cannot cross project selection', async () => {
  let project = 'a'; let ingested = () => {};
  const reads = new Map<string, (value:unknown) => void>();
  const ipc: NativeIpc = {
    invoke: <T,>(command:string, args?:Record<string,unknown>) => {
      if (command === 'list_projects') return Promise.resolve([{ id:project, root:`C:/fixture/${project}`, name:project }] as T);
      if (command === 'project_events') return Promise.resolve([] as T);
      if (command === 'claude_usage') return new Promise<T>(resolve => { reads.set(String(args?.projectId), value => resolve(value as T)); });
      return Promise.resolve(null as T);
    }, onIngested: listener => { ingested = listener; }, chooseFolder:async () => null,
  };
  const bridge = createNativeBridge('island', ipc, Date.now, 50, []);
  await settle(); project = 'b'; ingested(); await settle();
  reads.get('b')!({ status:'disabled' }); await settle();
  reads.get('a')!({ status:'incompatible', reason:'Old project' }); await settle();
  expect(bridge.connector?.project()?.id).toBe('b');
  expect(bridge.claudeUsage?.()).toEqual({ status:'disabled' });
});
