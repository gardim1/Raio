import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ConnectPreview, Connector, DesktopBridge, UsageOptIn } from '../../platform/desktopBridge';
import type { ProjectMapSnapshot } from '../project/projectMap';

// Invoke the real panel callbacks; preserve hook slots when Activity disconnects/reconnects effects.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[], bridge: null as DesktopBridge | null }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return hooks.slots[index] ?? (hooks.slots[index] = { current: initial });
  },
  useEffect: (setup: () => unknown) => { hooks.effects.push(setup); },
}));
vi.mock('../../platform/BridgeContext', () => ({ useBridge: () => hooks.bridge }));
vi.mock('../../shared/motion/visibleStore', () => ({ useSurfaceStore: (_subscribe: unknown, read: () => unknown) => read() }));
import { ConnectPanel, ConnectReview } from './ConnectPanel';
import { ConnectMapPreview } from './ConnectMapPreview';
import { createProjectFixtureBridge, createFixtureBridge } from '../../platform/fixtureBridge';

type Node = ReactElement<{ children?: unknown; onClick?: () => void; preview?: ConnectPreview; busy?:boolean; updatingUsage?:boolean; usageChoice?: UsageOptIn | null; usagePreviewFailed?: boolean; onRetryUsage?: () => void; onUsageChange?: (options:UsageOptIn) => void; map?: { kind: string }; state?: { kind: string }; onCancel?: () => void; onConnect?: () => void }>;
const find = (node: unknown, match: (node: Node) => boolean): Node | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as Node;
  if (match(element)) return element;
  for (const child of [element.props?.children].flat(2)) {
    const found = find(child, match); if (found) return found;
  }
  return null;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const preview: ConnectPreview = { before: null, after: '{}', settingsPath: 'C:/fixture/.claude/settings.local.json', gitIgnored: true };
let previews: ReturnType<typeof deferred<ConnectPreview>>[];
let maps: ReturnType<typeof deferred<ProjectMapSnapshot | null>>[];
let connector: Connector;
const render = (onPreviewRootChange?: (root: string | null) => void, chooseAnother = false, initialRoot?: string) => { hooks.cursor = 0; hooks.effects = []; return ConnectPanel({ connector, onPreviewRootChange, chooseAnother, initialRoot }); };
const review = () => find(render(), node => node.type === ConnectReview);
beforeEach(() => {
  hooks.slots = []; previews = []; maps = [];
  hooks.bridge = { ...createFixtureBridge(), previewProjectMap: vi.fn(() => { const pending = deferred<ProjectMapSnapshot | null>(); maps.push(pending); return pending.promise; }) };
  connector = { project: () => null, chooseFolder: async () => 'C:/fixture', preview: vi.fn(() => { const pending = deferred<ConnectPreview>(); previews.push(pending); return pending.promise; }), connect: vi.fn(), disconnect: vi.fn() };
});
const choose = async () => {
  const tree = render(); const setup = hooks.effects[0]!;
  const cleanup = setup() as () => void;
  find(tree, node => node.props?.children === 'Choose a folder')!.props.onClick!();
  await settle();
  return { setup, cleanup };
};
it('restarts the chosen folder settings and map after hide/reveal; stale answers cannot replace review', async () => {
  const { setup, cleanup } = await choose();
  cleanup();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  setup(); await settle();
  expect(connector.preview).toHaveBeenCalledTimes(2);
  expect(hooks.bridge!.previewProjectMap).toHaveBeenNthCalledWith(2, 'C:/fixture');
  previews[1]!.resolve(preview); maps[1]!.resolve(null); await settle();
  expect(review()?.props.preview).toEqual(preview);
  expect(review()?.props.map).toEqual({ kind: 'unavailable' });
});
it('restarts a map still pending after settings have resolved', async () => {
  const { setup, cleanup } = await choose();
  previews[0]!.resolve(preview); await settle();
  expect(review()?.props.map).toEqual({ kind: 'loading' });
  cleanup(); setup(); await settle();
  expect(maps).toHaveLength(2);
  const snapshot = createProjectFixtureBridge().currentProjectMap()!;
  previews[1]!.resolve(preview); maps[1]!.resolve(snapshot); await settle();
  maps[0]!.resolve(null); await settle();
  expect(review()?.props.map).toEqual({ kind: 'ready', snapshot });
});
it('does not replace a fully resolved review on reveal', async () => {
  const { setup, cleanup } = await choose();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  cleanup(); setup(); await settle();
  expect(connector.preview).toHaveBeenCalledTimes(1);
  expect(review()?.props.preview).toEqual(preview);
});
it('cancel clears the retained request and ignores its late answers', async () => {
  const { setup, cleanup } = await choose();
  find(render(), node => node.props?.children === 'Cancel')!.props.onClick!();
  cleanup(); setup();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  expect(connector.preview).toHaveBeenCalledTimes(1);
  expect(review()).toBeNull();
  expect(find(render(), node => node.props?.children === 'Choose a folder')).not.toBeNull();
});
it('unmount keeps late callbacks from publishing preview data', async () => {
  const { cleanup } = await choose();
  cleanup();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  expect(review()).toBeNull();
  expect(find(render(), node => node.type === ConnectMapPreview)?.props.state).toEqual({ kind: 'loading' });
});

it('older settings cannot overwrite the restarted folder review after they finish late', async () => {
  const { setup, cleanup } = await choose();
  cleanup(); setup(); await settle();
  previews[1]!.resolve(preview); maps[1]!.resolve(null); await settle();
  previews[0]!.resolve({ ...preview, settingsPath: 'C:/fixture/stale-settings.json' });
  maps[0]!.resolve(null); await settle();
  expect(review()?.props.preview).toEqual(preview);
  expect(review()?.props.map).toEqual({ kind: 'unavailable' });
});

it('publishes a chosen folder for the preview title and clears it on cancellation', async () => {
  const onRoot = vi.fn();
  const tree = render(onRoot);
  hooks.effects[0]!();
  find(tree, node => node.props?.children === 'Choose a folder')!.props.onClick!();
  await settle();
  expect(onRoot).toHaveBeenLastCalledWith('C:/fixture');
  find(render(onRoot), node => node.props?.children === 'Cancel')!.props.onClick!();
  expect(onRoot).toHaveBeenLastCalledWith(null);
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  expect(onRoot).toHaveBeenCalledTimes(2);
});

it('choosing another folder while connected only previews, and Cancel keeps the original connection', async () => {
  const original = { id: 'original', name: 'Original folder', root: 'C:/fixture/original' };
  connector.project = () => original;
  const tree = render(undefined, true); hooks.effects[0]!();
  find(tree, node => node.props?.children === 'Choose another folder')!.props.onClick!(); await settle();
  expect(connector.preview).toHaveBeenCalledWith('C:/fixture');
  expect(connector.connect).not.toHaveBeenCalled(); expect(connector.disconnect).not.toHaveBeenCalled();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  const card = find(render(undefined, true), node => node.type === ConnectReview)!;
  card.props.onCancel!();
  expect(connector.project()).toBe(original);
  expect(connector.connect).not.toHaveBeenCalled(); expect(connector.disconnect).not.toHaveBeenCalled();
  expect(find(render(undefined, true), node => node.props?.children === 'Choose another folder')).not.toBeNull();
});

it('switches a connected folder only through the explicit Connect callback', async () => {
  connector.project = () => ({ id: 'original', name: 'Original', root: 'C:/fixture/original' });
  const tree = render(undefined, true); hooks.effects[0]!();
  find(tree, node => node.props?.children === 'Choose another folder')!.props.onClick!(); await settle();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  const card = find(render(undefined, true), node => node.type === ConnectReview)!;
  expect(connector.connect).not.toHaveBeenCalled();
  card.props.onConnect!(); await settle();
  expect(connector.connect).toHaveBeenCalledExactlyOnceWith('C:/fixture', preview);
  expect(connector.disconnect).not.toHaveBeenCalled();
});

it('usage choices require a fresh exact preview before Connect and survive hide/reveal pending review', async () => {
  const { setup, cleanup } = await choose();
  previews[0]!.resolve(preview); maps[0]!.resolve(null); await settle();
  const choice = { enabled:true, replaceExisting:false };
  review()!.props.onUsageChange!(choice); await settle();
  expect(connector.preview).toHaveBeenLastCalledWith('C:/fixture', choice);
  expect(review()!.props.busy).toBe(false); expect(review()!.props.updatingUsage).toBe(true); expect(connector.connect).not.toHaveBeenCalled();
  expect(review()!.props.usageChoice).toEqual(choice);
  cleanup(); setup(); await settle();
  expect(connector.preview).toHaveBeenLastCalledWith('C:/fixture', choice);
  const fresh = { ...preview, after:'{"statusLine":{"type":"command","command":"synthetic"}}' };
  previews[2]!.resolve(fresh); maps[1]!.resolve(null); await settle();
  previews[1]!.resolve(preview); await settle();
  expect(review()!.props.preview).toEqual(fresh);
  expect(review()!.props.usageChoice).toBeNull();
  review()!.props.onConnect!(); await settle();
  expect(connector.connect).toHaveBeenCalledExactlyOnceWith('C:/fixture', fresh);
});

it('shows a sanitised preview failure reason and keeps retry available', async () => {
  render(undefined, false, 'C:/fixture/unreadable');
  hooks.effects[0]!();
  await settle();
  previews[0]!.reject(new Error('Access denied while reviewing C:/Users/private/project.'));
  await settle();
  const failed = render();
  expect(find(failed, node => node.type === 'p' && node.props?.children === 'Access denied while reviewing [folder].')).not.toBeNull();
  expect(find(failed, node => node.props?.children === 'Retry preview')).not.toBeNull();
  expect(find(failed, node => node.props?.children === 'C:/Users/private/project')).toBeNull();
});

it('keeps the newest usage choice visible and ignores an older preview that resolves later', async () => {
  await choose();
  previews[0]!.resolve({ ...preview, usage: { enabled:false, replaceExisting:false, effective:'user', fingerprint:'synthetic', before:null, after:null, reason:null } });
  maps[0]!.resolve(null);
  await settle();
  review()!.props.onUsageChange!({ enabled:false, replaceExisting:false });
  await settle();
  review()!.props.onUsageChange!({ enabled:true, replaceExisting:true });
  await settle();
  expect(review()!.props.usageChoice).toEqual({ enabled:true, replaceExisting:true });
  const latest = { ...preview, usage: { ...preview.usage!, enabled:true, replaceExisting:true } };
  previews[2]!.resolve(latest);
  await settle();
  previews[1]!.resolve({ ...preview, usage: { ...preview.usage!, enabled:false, replaceExisting:false } });
  await settle();
  expect(review()!.props.preview).toEqual(latest);
  expect(review()!.props.usageChoice).toBeNull();
});

it('does not connect with the previous diff when the selected usage preview fails', async () => {
  await choose();
  previews[0]!.resolve(preview);
  maps[0]!.resolve(null);
  await settle();
  review()!.props.onUsageChange!({ enabled:true, replaceExisting:true });
  await settle();
  previews[1]!.reject(new Error('Preview unavailable'));
  await settle();
  expect(review()!.props.usagePreviewFailed).toBe(true);
  expect(review()!.props.onRetryUsage).toBeTypeOf('function');
  review()!.props.onConnect!();
  await settle();
  expect(connector.connect).not.toHaveBeenCalled();
});
