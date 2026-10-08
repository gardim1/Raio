import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IslandShell } from './IslandShell';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { createElement } from 'react';

// Exercise the real shell handlers/effect with native IPC injected, without a webview or DOM.
const hooks = vi.hoisted(() => ({ open: false, visible: true, setup: null as (() => (() => void) | undefined) | null, ref: { current: null as unknown }, bridge: {} as ReturnType<typeof createFixtureBridge> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: () => [hooks.open, (value: boolean) => { hooks.open = value; }],
  useRef: () => hooks.ref,
  useEffect: (setup: typeof hooks.setup) => { hooks.setup = setup; },
  useId: () => 'island-preview-test',
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
it('capsule disclosure is a real button beside its named preview, and activation never changes surfaces', () => {
  const show = vi.fn(); hooks.bridge.showSurface = show;
  const el = capsule(); const stop = hooks.setup!()!;
  const content = el.props.children.props.children;
  const button = content[0].props.children[0]; const preview = content[1];
  expect(button?.type).toBe('button');
  expect(button.props['aria-label']).toBe('Raio: Fixture state');
  expect(button.props['aria-controls']).toBe(preview.props.id);
  expect(preview.props.role).toBe('group');
  expect(preview.props['aria-label']).toBe('Island preview');
  expect(el.props.tabIndex).toBeUndefined();
  button.props.onClick();
  button.props.onClick();
  expect(hooks.open).toBe(true);
  expect(show).not.toHaveBeenCalled();
  expect(capsule().props.children.props.children[0].props.children[0].props['aria-expanded']).toBe(true);
  stop();
});
it('hover and Escape keep collapsed label content in the same child slot instead of replacing it with the heading', () => {
  const label = createElement('span', { className: 'island__label' }, 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8));
  const button = () => IslandShell({ description: 'Fixture', collapsed: label, heading: 'Project heading', children: 'Preview' })
    .props.children.props.children.props.children[0].props.children[0];
  const closed = button(); const stop = hooks.setup!()!;
  expect(closed.props.children[0]?.props.children).toBe(label);
  expect(closed.props.children[0].props.hidden).toBe(false);
  const el = capsule(); el.props.onPointerEnter();
  const open = button();
  expect(open.props.children[0]?.props.children).toBe(label);
  expect(open.props.children[0].type).toBe(closed.props.children[0].type);
  expect(open.props.children[0].key).toBe(closed.props.children[0].key);
  expect(open.props.children[0].props.hidden).toBe(true);
  el.props.onKeyDown({ key: 'Escape', stopPropagation: () => {} });
  expect(button().props.children[0].props.children).toBe(label);
  expect(button().props.children[0].props.hidden).toBe(false);
  stop();
});
