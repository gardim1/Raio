/** Browser-only, labelled simulated activity; no native APIs, real settings or disk writes. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { useSessionUi } from '../../../src/features/session/store/sessionStore';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import { createSimulatedFeedBridge } from '../../../src/platform/fixtureBridge';
import type { DesktopBridge } from '../../../src/platform/desktopBridge';

export const mountReplayActivityFixture = () => {
  const base = createSimulatedFeedBridge({ fixedNowMs: 36_000 });
  let snapshot = base.currentSession()!;
  const listeners = new Set<() => void>();
  const bridge: DesktopBridge = {
    ...base,
    currentSession: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const append = () => {
    const atMs = snapshot.log.events.at(-1)!.atMs + 1000;
    snapshot = {
      ...snapshot,
      log: { ...snapshot.log, events: [...snapshot.log.events, { kind: 'session.start', atMs }] },
      simulatedFeed: { arrivalMs: [...snapshot.simulatedFeed!.arrivalMs, 36_001] },
    };
    listeners.forEach((listener) => listener());
  };
  const refresh = () => {
    snapshot = { ...snapshot, log: { ...snapshot.log, events: snapshot.log.events.map((event) => ({ ...event })) } };
    listeners.forEach((listener) => listener());
  };
  useSessionUi.setState({ mode: 'expanded', source: 'live', selectedNodeId: null, liveRun: 0, replayRun: 0 });
  const host = document.createElement('div');
  host.id = 'replay-activity-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#080c16' });
  document.body.append(host);
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement('div', { style: { position: 'fixed', top: 12, left: 12, zIndex: 101 } },
      createElement('span', null, 'Replay activity fixture · no real telemetry '),
      createElement('button', { onClick: append }, 'Append live activity'),
      createElement('button', { onClick: refresh }, 'Refresh same activity')),
    createElement(App)),
  }));
};
