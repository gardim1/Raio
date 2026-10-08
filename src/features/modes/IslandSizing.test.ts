import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HTMLMotionProps } from 'motion/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { deriveInsights } from '../session/model/insights';
import { ExpandedWindow } from './ExpandedWindow';
import { IslandMode } from './IslandMode';
import { fitIslandWidth } from './IslandShell';
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
  expect(expandedProps.layoutId).toBeTruthy();
  // CSS owns Island geometry now: it cannot join Motion's shared projection stack at all.
  expect(captured.divs.some(props => props.className?.split(' ').includes('island'))).toBe(false);
});

it.each([[0, 150], [40, 150], [60.1, 151], [120, 210], [250, 340], [1800, 340], [NaN, 150]])(
  'fits measured label width %s with the prototype formula and containment cap (%s)', (label, width) => {
    expect(fitIslandWidth(label)).toBe(width);
  },
);

const NODE_FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const css = readFileSync(new URL('../../app/styles/raio.css', import.meta.url), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
it.each([
  ['.island__dot', 'text-primary'],
  ['.island .island__dot[data-presence]', 'text-primary'],
  ['.island .island__dot[data-presence="working"]', 'accent-cool'],
  ['.island .island__dot[data-presence="attention"]', 'accent-warning'],
])('keeps the functional dot %s on the shared %s token', (selector, token) => {
  expect(rule(selector)).toContain(`background: var(--raio-color-${token})`);
  if (token === 'accent-cool') expect(rule(selector)).toContain('box-shadow: 0 0 6px var(--raio-color-accent-cool)');
});
it('keeps the owner-approved ZIP failure red local to the Island dot', () => {
  expect(rule('.island .island__dot[data-presence="failure"]')).toContain('background: #ff7b72');
});
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
it('uses the approved capsule, preview materials and CSS timing instead of projected geometry', () => {
  expect(rule('.island')).toContain('height: 34px');
  expect(rule('.island')).toContain('max-width: 340px');
  expect(rule('.island')).toContain('border-radius: 17px');
  expect(rule('.island')).toContain('background: rgba(20,21,26,.92)');
  expect(rule('.island')).toContain('border: 1px solid rgba(255,255,255,.08)');
  expect(rule('.island')).toContain('0 14px 30px -12px rgba(0,0,0,.7)');
  expect(rule('.island')).toContain('width .42s cubic-bezier(.2,1.15,.3,1)');
  expect(rule('.island--open')).toContain('width: 340px');
  expect(rule('.island--open')).toContain('height: var(--island-open-height, 144px)');
  expect(rule('.island--open')).toContain('border-radius: 24px');
  expect(rule('.island__closed')).toContain('gap: 8px');
  expect(rule('.island__closed')).toContain('padding: 0 12px 0 6px');
  expect(rule('.island__character')).toContain('width: 28px');
  expect(rule('.island__character')).toContain('height: 28px');
  expect(rule('.island__label')).toContain('font-size: 12.5px');
  expect(rule('.island__label')).toContain('font-weight: 500');
  expect(rule('.island__dot')).toContain('width: 6px');
  expect(rule('.island__preview')).toContain('position: absolute');
  expect(rule('.island__preview')).toContain('top: 54px');
  expect(rule('.island__preview')).toContain('padding: 0 14px 14px');
  expect(rule('.island__preview')).toContain('transform: translateY(-4px)');
  expect(rule('.island__preview')).toContain('transition: opacity .2s, transform .3s');
  expect(rule('.island--open .island__preview')).toContain('transition-delay: .1s');
  expect(rule('.island__actions button')).toContain('height: 28px');
  expect(rule('.island__actions button')).toContain('border-radius: 14px');
  expect(css).toContain('@media (prefers-reduced-motion: reduce) { .island, .island__preview { transition: none; } }');
});
it('bounds in-flow usage details inside the native window without shrinking controls or labels', () => {
  expect(rule('.island__usage .usage-details-wrap')).toContain('max-height: max(0px, min(280px, calc(100dvh - var(--island-top-inset, 10px) - 220px)))');
  expect(rule('.island__usage .usage-details-wrap')).toContain('overflow-y: auto');
  expect(rule('.island__usage .usage-rings__button')).toContain('min-height: 28px');
  expect(rule('.island__usage-summary')).toContain('font-size: 12px');
  expect(rule('.island__identity')).toContain('font-size: 12.5px');
  expect(rule('.island__label')).toContain('width: fit-content');
});
it('uses an explicit measured height and keeps preview opacity rendered for opening and closing', () => {
  expect(rule('.island--open')).toContain('height: var(--island-open-height, 144px)');
  expect(rule('.island--open')).not.toContain('height: auto');
  expect(rule('.island')).toContain('height .42s cubic-bezier(.2,1.15,.3,1)');
  expect(rule('.island__preview')).not.toContain('display: none');
  expect(rule('.island__preview')).toContain('opacity: 0');
  expect(rule('.island--open .island__preview')).not.toContain('display: block');
  expect(rule('.island__preview')).toContain('transition: opacity .2s, transform .3s');
  expect(rule('.island--open .island__preview')).toContain('transition-delay: .1s');
});
it('reserves the actions outside scrollable content when the viewport is the capped work-area height', () => {
  expect(rule('.island')).toContain('max-height: var(--island-max-height)');
  expect(rule('.island__preview')).toContain('max-height: calc(var(--island-max-height) - 56px)');
  expect(rule('.island__content')).toContain('min-height: 0');
  expect(rule('.island__content')).toContain('overflow-y: auto');
  expect(rule('.island__actions')).toContain('flex: none');
});
