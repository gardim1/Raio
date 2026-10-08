import { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { TitleBar, type TitleBarWindowApi } from './TitleBar';

// Run the real caption component/effect against an injected window, without native IPC or a DOM.
const hooks = vi.hoisted(() => ({ maximized: false, setup: null as (() => () => void) | null }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: () => [hooks.maximized, (value: boolean) => { hooks.maximized = value; }],
  useEffect: (setup: () => () => void) => { hooks.setup = setup; },
}));
const props = { project: 'fixture', agent: 'claude' as const, task: 'Fixture', taskVisible: true, status: 'working' as const };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const fixture = (initial = false) => {
  const state = { maximized: initial, closes: 0, minimizes: 0, stops: 0 };
  let resize = () => {};
  const api: TitleBarWindowApi = {
    close: async () => { state.closes++; },
    minimize: async () => { state.minimizes++; },
    toggleMaximize: async () => { state.maximized = !state.maximized; resize(); },
    startDragging: async () => {},
    isMaximized: async () => state.maximized,
    onResized: async (callback: () => void) => { resize = callback; return () => { state.stops++; }; },
  };
  const render = () => {
    const bar = TitleBar({ ...props, nativeWindow: api });
    const element = bar.props.children.at(-1) as ReactElement<{ nativeWindow: TitleBarWindowApi }>;
    expect(typeof element?.type).toBe('function');
    return (element.type as (props: typeof element.props) => ReactElement<{ children: ReactElement<{ onClick: () => Promise<void> }>[] }>)(element.props);
  };
  return { api, state, render, resize: () => resize() };
};
beforeEach(() => { hooks.maximized = false; hooks.setup = null; });

it('reads initial maximization and shows Restore with overlapping squares', async () => {
  const f = fixture(true);
  f.render(); const stop = hooks.setup!(); await settle();
  const html = renderToStaticMarkup(f.render());
  expect(html).toContain('aria-label="Restore" title="Restore"');
  expect(html).toContain('data-window-glyph="restore"');
  expect(html.match(/<rect /g)).toHaveLength(2);
  stop(); expect(f.state.stops).toBe(1);
});
it('reconciles OS maximization and restore on resize without clicking a caption', async () => {
  const f = fixture(); f.render(); const stop = hooks.setup!(); await settle();
  f.state.maximized = true; f.resize(); await settle();
  expect(renderToStaticMarkup(f.render())).toContain('aria-label="Restore"');
  f.state.maximized = false; f.resize(); await settle();
  expect(renderToStaticMarkup(f.render())).toContain('aria-label="Maximize" title="Maximize"');
  stop();
});
it('uses the injected close action and keeps minimize and toggle separate', async () => {
  const f = fixture(); const bar = f.render(); const stop = hooks.setup!(); await settle();
  await bar.props.children[2]!.props.onClick();
  expect(f.state).toMatchObject({ closes: 1, minimizes: 0, maximized: false });
  await bar.props.children[0]!.props.onClick(); expect(f.state.minimizes).toBe(1);
  await bar.props.children[1]!.props.onClick(); await settle();
  expect(renderToStaticMarkup(f.render())).toContain('aria-label="Restore"');
  stop();
});
it('ignores an older state answer after a newer resize answer', async () => {
  const f = fixture(); const older = deferred<boolean>(); const newer = deferred<boolean>();
  const answers = [older.promise, newer.promise]; f.api.isMaximized = () => answers.shift()!;
  f.render(); const stop = hooks.setup!(); await settle(); f.resize();
  newer.resolve(true); await settle(); older.resolve(false); await settle();
  expect(renderToStaticMarkup(f.render())).toContain('aria-label="Restore"'); stop();
});
it('cleans up a late listener registration and never applies its late state', async () => {
  const f = fixture(true); const registered = deferred<() => void>();
  f.api.onResized = async () => registered.promise;
  f.render(); const stop = hooks.setup!(); stop();
  registered.resolve(() => { f.state.stops++; }); await settle();
  expect(f.state.stops).toBe(1); expect(hooks.maximized).toBe(false);
});
it('ignores an in-flight state answer after the caption is hidden or unmounted', async () => {
  const f = fixture(); const answer = deferred<boolean>(); f.api.isMaximized = () => answer.promise;
  f.render(); const stop = hooks.setup!(); await settle(); stop(); answer.resolve(true); await settle();
  expect(hooks.maximized).toBe(false); expect(f.state.stops).toBe(1);
});
