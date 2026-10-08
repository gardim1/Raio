import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IslandShell } from './IslandShell';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { createElement } from 'react';
import { mountCharacter } from '../raio/character/runtime';
import type { CharacterEngine } from '../raio/character/engine';

// Exercise the real shell handlers/effect with native IPC injected, without a webview or DOM.
const hooks = vi.hoisted(() => ({ open: false, visible: true, setup: null as (() => (() => void) | undefined) | null, ref: { current: null as unknown }, bridge: {} as ReturnType<typeof createFixtureBridge> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => initial === 150 ? [150, () => {}] : [hooks.open, (value: boolean) => { hooks.open = value; }],
  useRef: () => hooks.ref,
  useEffect: (setup: typeof hooks.setup) => { hooks.setup = setup; },
  useLayoutEffect: () => {},
  useId: () => 'island-preview-test',
}));
vi.mock('../../platform/BridgeContext', () => ({ useBridge: () => hooks.bridge }));
vi.mock('../../shared/motion/surfaceVisibility', async original => ({ ...await original<typeof import('../../shared/motion/surfaceVisibility')>(), useSurfaceVisible: () => hooks.visible }));
const actions = { onPinMini: vi.fn(), onExpand: vi.fn() };
const capsule = () => IslandShell({ description: 'Fixture state', collapsed: 'Capsule', children: 'Preview', ...actions }).props.children;
beforeEach(() => { hooks.open = false; hooks.visible = true; hooks.ref.current = null; hooks.setup = null; hooks.bridge = createFixtureBridge(null); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
  el.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); vi.advanceTimersByTime(260); expect(hooks.open).toBe(false);
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
  const content = el.props.children;
  const button = content[0]; const preview = content[1];
  expect(button?.type).toBe('button');
  expect(button.props['aria-label']).toBe('Raio: Fixture state');
  expect(button.props['aria-controls']).toBe(preview.props.id);
  expect(preview.props.role).toBe('group');
  expect(preview.props['aria-label']).toBe('Island preview');
  expect(preview.props['aria-hidden']).toBe(true); expect(preview.props.inert).toBe(true);
  expect(el.props.tabIndex).toBeUndefined();
  button.props.onClick();
  button.props.onClick();
  expect(hooks.open).toBe(true);
  expect(show).not.toHaveBeenCalled();
  expect(capsule().props.children[0].props['aria-expanded']).toBe(true);
  expect(capsule().props.children[1].props['aria-hidden']).toBe(false);
  expect(capsule().props.children[1].props.inert).toBe(false);
  stop();
});
it('hover and Escape keep the same visible header label in the same child slot', () => {
  const label = createElement('span', { className: 'island__label' }, 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8));
  const button = () => IslandShell({ description: 'Fixture', collapsed: label, children: 'Preview', ...actions })
    .props.children.props.children[0];
  const closed = button(); const stop = hooks.setup!()!;
  expect(closed.props.children.props.children).toBe(label);
  expect(closed.props.children.props.hidden).toBeUndefined();
  const el = capsule(); el.props.onPointerEnter();
  const open = button();
  expect(open.props.children.props.children).toBe(label);
  expect(open.props.children.type).toBe(closed.props.children.type);
  expect(open.props.children.key).toBe(closed.props.children.key);
  expect(open.props.children.props.hidden).toBeUndefined();
  el.props.onKeyDown({ key: 'Escape', stopPropagation: () => {} });
  expect(button().props.children.props.children).toBe(label);
  expect(button().props.children.props.hidden).toBeUndefined();
  stop();
});
it('double-click is consumed without switching a surface or asking for window focus', () => {
  const show = vi.fn(); hooks.bridge.showSurface = show;
  const el = capsule();
  expect(el.props.onDoubleClick).toBeTypeOf('function');
  const preventDefault = vi.fn(); const stopPropagation = vi.fn();
  el.props.onDoubleClick({ preventDefault, stopPropagation });
  expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
  expect(show).not.toHaveBeenCalled();
});
const cookie = () => capsule().props.children[1].props.children[1]?.props?.children?.[2];
it('cookie exists only in the visible open preview as a keyboard-reachable icon button', () => {
  expect(cookie()).toBeFalsy();
  hooks.open = true;
  const button = cookie();
  expect(button?.type).toBe('button');
  expect(button.props.type).toBe('button'); expect(button.props.tabIndex).toBeUndefined();
  expect(button.props['aria-label']).toBe('Give Raio a cookie');
  expect(button.props.title).toBe('Give Raio a cookie');
  expect(button.props.children.type).toBe('svg'); expect(button.props.children.props['aria-hidden']).toBe(true);
  hooks.visible = false; expect(cookie()).toBeFalsy();
});
it('cookie activation sends exactly one real window-bus reaction without changing disclosure or surfaces', () => {
  hooks.open = true;
  const button = cookie(); expect(button).toBeDefined();
  const show = vi.fn(); hooks.bridge.showSurface = show;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } } }));
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const react = vi.fn();
  const stop = mountCharacter({ update: () => false, sense: () => {}, leave: () => {}, react, dispose: () => {} } as unknown as CharacterEngine);
  try {
    const stopPropagation = vi.fn();
    button.props.onClick({ stopPropagation });
    expect(react).toHaveBeenCalledExactlyOnceWith('cookie');
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(actions.onPinMini).not.toHaveBeenCalled(); expect(actions.onExpand).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
    expect(hooks.open).toBe(true);
  } finally { stop(); }
});
it('Escape from the cookie returns focus to the persistent disclosure before removing the focused button', () => {
  const el = capsule(); const stop = hooks.setup!()!;
  el.props.onFocus(); expect(hooks.open).toBe(true);
  const focus = vi.fn(() => el.props.onFocus());
  el.props.onKeyDown({ key: 'Escape', stopPropagation: () => {},
    target: { closest: (selector: string) => selector === '.island__cookie' },
    currentTarget: { querySelector: (selector: string) => selector === '.island__trigger' ? { focus } : null },
  });
  expect(focus).toHaveBeenCalledOnce();
  expect(hooks.open).toBe(false); expect(cookie()).toBeFalsy();
  stop();
});
