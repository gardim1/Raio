import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge, createProjectFixtureBridge } from '../../platform/fixtureBridge';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { deriveInsights } from '../session/model/insights';
import { derivePresence } from './presence';
import { ExpandedWindow } from './ExpandedWindow';
import { IslandMode } from './IslandMode';
import { MiniSurface } from './MiniSurface';
import { ProjectOnlyView } from '../project/ProjectOnlyView';

// SSR normally shows the collapsed Island. Set only its first state slot to open to inspect shortcuts.
const hooks = vi.hoisted(() => ({ openIsland: false }));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    if (hooks.openIsland) { hooks.openIsland = false; return actual.useState(true); }
    return actual.useState(initial);
  } };
});
const bridge = createFixtureBridge();
const snapshot = bridge.currentSession()!;
const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
const presence = derivePresence(canonicalScript, snapshot.graph, frame, false);
const noop = () => {};
const render = (children: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(BridgeProvider, { bridge, children }));
const shortcut = (html: string, label: string) => {
  const button = html.match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>[\\s\\S]*?</button>'))?.[0];
  expect(button).toBeDefined();
  expect(button).toContain('title="' + label + '"');
  return button!;
};
const expectMini = (html: string) => {
  const button = shortcut(html, 'Open Mini Player');
  expect(button).toContain('viewBox="0 0 14 14"');
  expect(button).toContain('fill="currentColor"');
  expect(button.match(/<rect /g)).toHaveLength(2);
};
const expectIsland = (html: string) => {
  const button = shortcut(html, 'Show as Island');
  expect(button).toContain('viewBox="0 0 14 14"');
  expect(button.match(/<rect /g)).toHaveLength(2);
  expect(button).toContain('rx="1.5"');
};
it.each([false, true])('Expanded keeps distinct Mini/Island shortcuts during replay=%s', isReplay => {
  const html = render(createElement(ExpandedWindow, { script: canonicalScript, frame, graph: snapshot.graph, project: snapshot.project,
    insights: deriveInsights(snapshot.log), presence, selectedNodeId: null, isReplay,
    onSelectNode: noop, onSelectEvent: noop, onPinMini: noop, onIsland: noop, onViewChanges: noop }));
  expectMini(html); expectIsland(html);
});
it('pre-session Expanded uses the same Mini/Island shortcuts', () => {
  const html = render(createElement(ProjectOnlyView, { snapshot: createProjectFixtureBridge().currentProjectMap()!, mode: 'expanded' }));
  expectMini(html); expectIsland(html);
});
it('open Island offers Mini Player with the picture-in-picture icon', () => {
  hooks.openIsland = true;
  expectMini(render(createElement(IslandMode, { script: canonicalScript, frame, presence, onPinMini: noop, onExpand: noop, onViewChanges: noop })));
});
it.each([false, true])('Mini distinguishes Island from its always-on-top toggle (pinned=%s)', pinned => {
  const html = render(createElement(MiniSurface, { project: 'fixture', status: 'ready', stateLabel: 'Ready', pinned,
    onTogglePin: noop, onExpand: noop, onCollapse: noop, children: null }));
  expectIsland(html);
  const pin = shortcut(html, pinned ? 'Stop keeping on top' : 'Keep on top');
  expect(pin).toContain('M5 1.8h4');
  expect(pin).not.toContain('<rect');
  if (pinned) expect(pin).toContain('aria-pressed="true"');
});
