import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IslandShell } from './IslandShell';
import { createFixtureBridge } from '../../platform/fixtureBridge';

// Exercise the real shell handlers/effect with native IPC injected, without a webview or DOM.
const hooks = vi.hoisted(() => ({ open: false, visible: true, setup: null as (() => (() => void) | undefined) | null, ref: { current: null as unknown }, bridge: {} as ReturnType<typeof createFixtureBridge> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: () => [hooks.open, (value: boolean) => { hooks.open = value; }],
  useRef: () => hooks.ref,
  useEffect: (setup: typeof hooks.setup) => { hooks.setup = setup; },
}));
vi.mock('../../platform/BridgeContext', () => ({ useBridge: () => hooks.bridge }));
vi.mock('../../shared/motion/surfaceVisibility', () => ({ useSurfaceVisible: () => hooks.visible }));
const capsule = () => IslandShell({ description: 'Fixture state', collapsed: 'Capsule', children: 'Preview' }).props.children;
beforeEach(() => { hooks.open = false; hooks.visible = true; hooks.ref.current = null; hooks.setup = null; hooks.bridge = createFixtureBridge(null); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it('native Island opens only from core pointer truth, never asks to switch a surface or focus a window', async () => {
  let send!: (inside: boolean) => void; let stops = 0; const show = vi.fn();
  hooks.bridge = { ...hooks.bridge, kind: 'native', fixedSurface: 'island', showSurface: show, onIslandPointer: async handler => { send = handler; return () => { stops++; }; } };
  let el = capsule(); const stop = hooks.setup!()!; await Promise.resolve();
  expect(el.props.onPointerEnter).toBeUndefined(); expect(el.props.onPointerLeave).toBeUndefined();
  send(true); el = capsule(); expect(el.props['aria-expanded']).toBe(true);
  const stopPropagation = vi.fn(); el.props.onClick({ stopPropagation }); expect(stopPropagation).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled();
  send(false); vi.advanceTimersByTime(249); expect(capsule().props['aria-expanded']).toBe(true);
  send(true); vi.advanceTimersByTime(1); expect(capsule().props['aria-expanded']).toBe(true);
  stop(); expect(stops).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it('browser hover, focus-within and Escape use the same compact preview and cancel exit on re-entry', () => {
  let el = capsule(); const stop = hooks.setup!()!;
  el.props.onPointerEnter(); expect(capsule().props['aria-expanded']).toBe(true);
  el.props.onPointerLeave(); el.props.onFocus(); vi.advanceTimersByTime(300); expect(hooks.open).toBe(true);
  el.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }); vi.advanceTimersByTime(300); expect(hooks.open).toBe(true);
  el.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); vi.advanceTimersByTime(250); expect(hooks.open).toBe(false);
  el.props.onPointerEnter(); el = capsule(); el.props.onKeyDown({ key: 'Escape', stopPropagation: () => {} }); expect(hooks.open).toBe(false);
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('hidden Island registers no pointer work and renders no open preview', () => {
  hooks.visible = false; hooks.open = true; const listen = vi.fn(); hooks.bridge.onIslandPointer = listen;
  expect(capsule().props['aria-expanded']).toBe(false); hooks.setup!(); expect(listen).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
