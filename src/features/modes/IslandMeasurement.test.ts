import { afterEach, expect, it, vi } from 'vitest';
import { IslandShell } from './IslandShell';

const hooks = vi.hoisted(() => ({ visible: true, measure: null as (() => (() => void) | undefined) | null, width: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [initial, initial === 150 ? hooks.width : () => {}],
  useRef: () => ({ current: null }), useEffect: () => {}, useId: () => 'preview',
  useLayoutEffect: (setup: typeof hooks.measure) => { hooks.measure = setup; },
}));
vi.mock('../../platform/BridgeContext', () => ({ useBridge: () => ({ kind: 'fixture' }) }));
vi.mock('../../shared/motion/surfaceVisibility', () => ({ useSurfaceVisible: () => hooks.visible }));
afterEach(() => { hooks.visible = true; hooks.width.mockClear(); vi.unstubAllGlobals(); });

it('refits after fonts settle and releases observation without a late hidden update', async () => {
  let ready!: () => void;
  vi.stubGlobal('document', { fonts: { ready: new Promise<void>(resolve => { ready = resolve; }) } });
  const observe = vi.fn(); const disconnect = vi.fn();
  let resized!: () => void;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe; disconnect = disconnect;
  });
  const label = { scrollWidth: 40 };
  const shell = IslandShell({ description: 'Fixture', collapsed: 'Label', children: 'Preview' }).props.children;
  shell.props.ref.current = { querySelector: () => label };
  const stop = hooks.measure!()!;
  expect(hooks.width).toHaveBeenLastCalledWith(150); expect(observe).toHaveBeenCalledWith(label);
  label.scrollWidth = 120; ready(); await Promise.resolve();
  expect(hooks.width).toHaveBeenLastCalledWith(210);
  label.scrollWidth = 1800; resized();
  expect(hooks.width).toHaveBeenLastCalledWith(340);
  stop(); expect(disconnect).toHaveBeenCalledOnce();
  hooks.width.mockClear(); resized();
  expect(hooks.width).not.toHaveBeenCalled();
});

it('does no label measurement or observer registration while hidden', () => {
  hooks.visible = false;
  const querySelector = vi.fn();
  const shell = IslandShell({ description: 'Fixture', collapsed: 'Label', children: 'Preview' }).props.children;
  shell.props.ref.current = { querySelector };
  expect(hooks.measure!()).toBeUndefined();
  expect(querySelector).not.toHaveBeenCalled(); expect(hooks.width).not.toHaveBeenCalled();
});
