import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProjectionNode } from 'motion-dom';
import type { HTMLMotionProps } from 'motion/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { deriveInsights } from '../session/model/insights';
import { ExpandedWindow } from './ExpandedWindow';
import { IslandMode } from './IslandMode';
import { derivePresence } from './presence';

// Capture our real components' projection options; keep Motion rendering/projection code real.
const captured = vi.hoisted(() => ({ divs: [] as HTMLMotionProps<'div'>[] }));
vi.mock('motion/react', async original => {
  const actual = await original<typeof import('motion/react')>();
  const react = await import('react');
  const Div = (props: HTMLMotionProps<'div'>) => {
    captured.divs.push(props);
    return react.createElement(actual.motion.div, props);
  };
  return { ...actual, motion: new Proxy(actual.motion, { get: (target, key) => key === 'div' ? Div : Reflect.get(target, key) }) };
});
afterEach(() => { captured.divs.length = 0; });
const bridge = createFixtureBridge();
const snapshot = bridge.currentSession()!;
const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
const presence = derivePresence(canonicalScript, snapshot.graph, frame, false);
const noop = () => {};
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: child }));
const longLabel = 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8);
const session = () => createElement(IslandMode, {
  script: canonicalScript, frame, presence,
  companion: { state: 'attention', label: longLabel, description: longLabel, records: [], activeUntil: null },
  onPinMini: noop, onExpand: noop, onViewChanges: noop,
});

it('long-label session Island never inherits Expanded geometry during surface handoff', () => {
  render(createElement(ExpandedWindow, {
    script: canonicalScript, frame, presence, graph: snapshot.graph, project: snapshot.project,
    insights: deriveInsights(snapshot.log), selectedNodeId: null, isReplay: false,
    onSelectNode: noop, onSelectEvent: noop, onPinMini: noop, onIsland: noop, onViewChanges: noop,
  }));
  const expandedProps = captured.divs.find(props => props.className === 'panel expanded')!;
  expect(render(session())).toContain(longLabel);
  const islandProps = captured.divs.find(props => props.className === 'island')!;

  // A narrow characterization of the unexpected handoff: CSS max-width cannot cap a transform
  // copied from a shared peer. Feed the actual component options to Motion's real node stack.
  const Node = createProjectionNode({ measureScroll: () => ({ x: 0, y: 0 }), checkIsScrollRoot: () => false, resetTransform: () => {} });
  const root = new Node();
  const expanded = new Node({}, root);
  expanded.setOptions({ layoutId: expandedProps.layoutId, layoutDependency: expandedProps.layoutDependency });
  const box = { x: { min: 220, max: 1220 }, y: { min: 190, max: 710 } };
  expanded.snapshot = { source: expanded.id, animationId: 0, measuredBox: box, layoutBox: box, latestValues: {} };
  if (expanded.options.layoutId) root.registerSharedNode(expanded.options.layoutId, expanded);
  const island = new Node({}, root);
  island.setOptions({ layoutId: islandProps.layoutId, layout: Boolean(islandProps.layout), layoutDependency: islandProps.layoutDependency });
  if (island.options.layoutId) root.registerSharedNode(island.options.layoutId, island);
  expect(island.resumeFrom === expanded).toBe(false);
  expect(island.snapshot).toBeUndefined();
  expect(island.options.layout).toBe(true); // Own hover spring remains enabled.
});

const NODE_FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const css = readFileSync(new URL('../../app/styles/raio.css', import.meta.url), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
it('every collapsed Island label can shrink and ellipsize within the open capsule width', () => {
  expect(render(session())).toContain('class="island__label"');
  const openWidth = Number(rule('.island--open').match(/(?:^|;)\s*width:\s*(\d+)px/)?.[1]);
  const maxWidth = Number(rule('.island').match(/max-width:\s*(\d+)px/)?.[1]);
  const closedMax = Number(rule('.island__closed').match(/max-width:\s*(\d+)px/)?.[1]);
  expect(maxWidth).toBeLessThanOrEqual(openWidth);
  expect(closedMax).toBeLessThanOrEqual(openWidth);
  expect(rule('.island__label')).toMatch(/(?:^|;)\s*min-width:\s*0\s*;/);
  expect(rule('.island__label')).toContain('overflow: hidden');
  expect(rule('.island__label')).toContain('text-overflow: ellipsis');
});
