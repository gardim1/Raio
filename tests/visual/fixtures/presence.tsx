/** Development-only in-memory presence controls; never native telemetry or settings. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { useSessionUi } from '../../../src/features/session/store/sessionStore';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import { createFixtureBridge, createSimulatedFeedBridge } from '../../../src/platform/fixtureBridge';
import type { DesktopBridge, Surface } from '../../../src/platform/desktopBridge';
import type { PresenceFact, PresenceInput } from '../../../src/features/modes/companionPresence';
import { setNativeSurfaceVisible } from '../../../src/shared/motion/surfaceVisibility';

export type FixturePresence = 'connected' | 'working' | 'attention' | 'failure' | 'historical' | 'passed' | 'unknown' | 'disconnected';
let update: (state: FixturePresence) => void;
let finish: () => void;
export const setPresence = (state: FixturePresence) => update(state);
export const finishSession = () => finish();
export const setVisible = setNativeSurfaceVisible;
export const setMode = (mode: Surface) => useSessionUi.getState().setMode(mode);

export const mountPresenceFixture = (options: { canonical?: boolean } = {}) => {
  setNativeSurfaceVisible(true);
  const base = options.canonical ? createFixtureBridge() : createSimulatedFeedBridge({ fixedNowMs: 8000 });
  let snapshot = base.currentSession()!;
  let presence: PresenceInput = { connected: true, available: true, facts: [] };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  update = state => {
    const at = Date.now() - 2000;
    const failed: PresenceFact = { id: 'failed', sessionId: 'demo', kind: 'check', checkClass: 'tests', result: 'failed', at, source: 'Demo fixture check' };
    const facts: PresenceFact[] = state === 'working' ? [{ id: 'activity', kind: 'activity', at: Date.now(), source: 'Demo fixture' }]
      : state === 'attention' ? [{ id: 'migration', kind: 'change', change: 'added', paths: ['migrations/001_demo.sql'], at, source: 'Demo fixture watcher' }]
      : state === 'failure' ? [failed]
      : state === 'historical' ? [failed, { id: 'changed', sessionId: 'demo', kind: 'change', paths: ['src/demo.ts'], at: at + 1000, source: 'Demo fixture watcher' }]
      : state === 'passed' ? [failed, { id: 'pass', sessionId: 'demo', kind: 'check', checkClass: 'tests', result: 'passed', at: at + 1000, source: 'Demo fixture check' }]
      : [];
    presence = { connected: state !== 'disconnected', available: state !== 'unknown', facts };
    notify();
  };
  finish = () => { snapshot = createSimulatedFeedBridge({ fixedNowMs: 36_000 }).currentSession()!; notify(); };
  const bridge: DesktopBridge = {
    ...base,
    currentSession: () => snapshot,
    projectPresence: () => presence,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  useSessionUi.setState({ mode: 'expanded', source: 'live', selectedNodeId: null, liveRun: 0, replayRun: 0 });
  const host = document.createElement('div');
  host.id = 'presence-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#080c16' });
  document.body.append(host);
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement('p', { style: { position: 'fixed', top: 0, left: 12, zIndex: 101 } }, 'Presence fixture · no real telemetry'),
    createElement(App)),
  }));
};
