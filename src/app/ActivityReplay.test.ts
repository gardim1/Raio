import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { DesktopBridge } from '../platform/desktopBridge';

// Exercise the product's effect callbacks with state/refs retained exactly across effect reconnection.
// This is a lifecycle regression, not a mounted DOM or native-window test.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], cursor: 0,
  effects: [] as { setup: () => unknown; deps?: unknown[] }[],
  bridge: null as DesktopBridge | null, clock: 0,
  replay: { t: 0, playing: false, speed: 1, restart() { this.t = 0; this.playing = true; }, pause() { this.playing = false; }, seek(t: number) { this.t = t; }, toggle() {}, play() {}, setSpeed() {} },
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (setup: () => unknown, deps?: unknown[]) => { hooks.effects.push({ setup, deps }); },
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => hooks.refs[hooks.cursor++] ?? (hooks.refs[hooks.cursor - 1] = { current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
}));
vi.mock('../platform/BridgeContext', () => ({ useBridge: () => hooks.bridge, useSessionSnapshot: () => hooks.bridge!.currentSession(), useProjectMapSnapshot: () => null }));
vi.mock('../shared/motion/visibleStore', () => ({ useSurfaceStore: (_subscribe: unknown, read: () => unknown) => read() }));
vi.mock('../shared/motion/surfaceVisibility', () => ({ useSurfaceVisible: () => true, isSurfaceVisible: () => true, subscribeSurfaceVisibility: () => () => {} }));
vi.mock('../shared/motion/usePlayback', () => ({ usePlayback: () => ++hooks.clock === 2 ? hooks.replay : { ...hooks.replay, playing: false } }));
vi.mock('../features/session/live/useLiveFollow', () => ({ useLiveFollow: () => null }));
import { App } from './App';
import { createFixtureBridge } from '../platform/fixtureBridge';
import { useSessionUi } from '../features/session/store/sessionStore';

type Node = ReactElement<{ children?: unknown; snapshot?: unknown }>;
const findSurface = (node: unknown): Node | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as Node;
  if (typeof element.type === 'function' && element.type.name === 'Surfaces') return element;
  for (const child of [element.props?.children].flat(2)) {
    const found = findSurface(child);
    if (found) return found;
  }
  return null;
};
const render = () => {
  hooks.cursor = 0; hooks.clock = 0; hooks.effects = [];
  const surface = findSurface(App({}))!;
  expect(surface).not.toBeNull();
  (surface.type as (props: unknown) => unknown)(surface.props);
  return hooks.effects.find(effect => effect.deps?.length === 1 && effect.deps[0] === useSessionUi.getState().replayRun)!.setup;
};
beforeEach(() => {
  hooks.bridge = createFixtureBridge(); hooks.refs = []; hooks.replay.t = 0; hooks.replay.playing = false;
  useSessionUi.setState({ source: 'replay', replayRun: 1, liveRun: 0 });
});
it('reconnecting effects preserves a paused replay at seven seconds', () => {
  const setup = render();
  setup();
  hooks.replay.seek(7); hooks.replay.pause();
  setup();
  expect({ t: hooks.replay.t, playing: hooks.replay.playing }).toEqual({ t: 7, playing: false });
});
it('a new replay request restarts, while reconnection of that run preserves progress', () => {
  render()();
  hooks.replay.seek(7); hooks.replay.pause();
  useSessionUi.getState().startReplay();
  const setup = render();
  setup();
  expect({ t: hooks.replay.t, playing: hooks.replay.playing }).toEqual({ t: 0, playing: true });
  hooks.replay.seek(4);
  setup();
  expect({ t: hooks.replay.t, playing: hooks.replay.playing }).toEqual({ t: 4, playing: true });
});
