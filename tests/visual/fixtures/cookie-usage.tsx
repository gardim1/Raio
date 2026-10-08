/** DEMO only: no native calls, filesystem reads, settings writes or account data. */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { USAGE_DEMO_NOW, USAGE_DEMO_STATES } from '../../../src/dev-harness/UsageDemoPanel';
import type { ClaudeUsageState } from '../../../src/features/usage/claudeUsage';
import { characterLoop, setCharacterFrozenTime, setCharacterRandom, setCharacterReducedMotion } from '../../../src/features/raio/character/runtime';
import { useSessionUi } from '../../../src/features/session/store/sessionStore';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import { createFixtureBridge, createProjectFixtureBridge } from '../../../src/platform/fixtureBridge';
import { setNativeSurfaceVisible } from '../../../src/shared/motion/surfaceVisibility';

export interface CookieUsageFixtureControls {
  __cookieAdvance(seconds: number): void;
  __cookieVisible(visible: boolean): void;
  __cookieUnmount(): void;
  __cookieUi(): { mode: string; source: string; selectedNodeId: string | null; sessionId: string | undefined };
  __usageState(id: string): void;
}
declare global { interface Window extends CookieUsageFixtureControls {} }
export const mountCookieUsageFixture = ({ session = false, usage = 'disabled', reduced = false }: { session?: boolean; usage?: string; reduced?: boolean } = {}) => {
  setNativeSurfaceVisible(true); setCharacterFrozenTime(0); setCharacterRandom(() => .5); setCharacterReducedMotion(reduced);
  for (const child of document.body.children) if (child instanceof HTMLElement) child.inert = true;
  const host = document.createElement('div'); host.id = 'cookie-usage-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#0a0b0e' });
  document.body.append(host);
  let state: ClaudeUsageState = USAGE_DEMO_STATES.find(item => item.id === usage)!.state;
  const listeners = new Set<() => void>();
  const base = session ? createFixtureBridge() : createProjectFixtureBridge({ hooksState: 'current' });
  const bridge = { ...base, fixedSurface: 'expanded' as const,
    claudeUsage: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  useSessionUi.setState({ mode: 'expanded', source: 'live', selectedNodeId: null, liveRun: 0, replayRun: 0 });
  const root = createRoot(host);
  root.render(createElement(BridgeProvider, { bridge, children: createElement(App) }));
  const target = window as Window & CookieUsageFixtureControls;
  target.__cookieAdvance = seconds => flushSync(() => characterLoop().advance(seconds));
  target.__cookieVisible = visible => flushSync(() => setNativeSurfaceVisible(visible));
  target.__cookieUnmount = () => { flushSync(() => root.unmount()); host.remove(); };
  target.__cookieUi = () => {
    const { mode, source, selectedNodeId } = useSessionUi.getState();
    return { mode, source, selectedNodeId, sessionId: base.currentSession()?.log.id };
  };
  target.__usageState = id => flushSync(() => {
    state = USAGE_DEMO_STATES.find(item => item.id === id)!.state;
    listeners.forEach(listener => listener());
  });
  // Usage demo time is explicit in the bridge fixture; the product still reads Date.now().
  return USAGE_DEMO_NOW;
};
