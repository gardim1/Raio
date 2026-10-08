import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import * as bridgeContext from '../../platform/BridgeContext';
import { createFixtureBridge, createProjectFixtureBridge } from '../../platform/fixtureBridge';
import { deriveCompanionPresence, type PresenceInput } from './companionPresence';
import { IdleIsland } from './IdleIsland';
import { IslandMode } from './IslandMode';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { derivePresence } from './presence';
import { factsFromEvents } from './presenceFacts';
import { projectSession } from '../project/projectSession';
import type { RaioEvent } from '../ingest/raioEvent';

// SSR does not deliver hover: inspect open content, while IslandInteraction tests the real transition.
vi.mock('react', async original => { const actual = await original<typeof import('react')>(); return { ...actual,
  useState: (initial: unknown) => actual.useState(initial === false ? true : initial),
}; });
const render = (bridge: ReturnType<typeof createFixtureBridge>, child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: child }));
const input: PresenceInput = { connected: true, available: true, facts: [] };
it.each([
  { ...input, connected: false }, input, { ...input, available: false },
  { ...input, hooks: 'outdated' as const },
  { ...input, facts: [{ id: 'a', kind: 'activity' as const, at: 60_000, source: 'Fixture watcher' }] },
  { ...input, facts: [{ id: 'f', kind: 'check' as const, at: 0, checkClass: 'tests', result: 'failed' as const, source: 'Fixture hook' }] },
])('idle preview distinguishes connected=$connected available=$available hooks=$hooks', state => {
  const bridge = { ...(state.connected ? createProjectFixtureBridge() : createFixtureBridge(null)), projectPresence: () => state };
  const companion = deriveCompanionPresence(state, 60_000, 'UTC');
  const child = createElement(IdleIsland, { companion, onOpen: () => {} });
  const html = render(bridge, child);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('Open window'); expect(html).toContain('Open Mini Player');
  if (companion.state !== 'working') expect(html).not.toContain('working');
  if (!state.connected) expect(html).toContain('Choose a project');
  else if (!state.available) expect(html).toContain('Activity status unavailable');
  else if (companion.state === 'connected') expect(html).toContain('No agent active right now.');
  else if (companion.state === 'working') { expect(html).toContain('Recent observed activity'); expect(html).toContain('Agent unknown'); expect(html).toContain('Fixture watcher'); }
  else { expect(html).toContain(companion.label); expect(html).toContain(companion.description); }
});
it('session preview shows the real project, agent and latest observed operation', () => {
  const bridge = createFixtureBridge(); const snapshot = bridge.currentSession()!;
  const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
  const html = render(bridge, createElement(IslandMode, { script: canonicalScript, frame, presence: derivePresence(canonicalScript, snapshot.graph, frame, false), onPinMini: () => {}, onExpand: () => {}, onViewChanges: () => {} }));
  expect(html).toContain(snapshot.project); expect(html).toContain('Claude Code'); expect(html).toContain('Turn ended');
  expect(html).not.toContain('Checks passed'); expect(html).not.toContain('island__dot--success');
});
it('session preview advances beyond the last replay file read to command and Stop observations', () => {
  const start = new Date(2026, 9, 8, 14, 0).getTime();
  const event = (minute: number, kind: RaioEvent['kind'], paths: string[] = []): RaioEvent => ({
    schema: 1, id: String(minute), seq: minute, projectId: 'p', sessionId: 's',
    agent: 'claude', source: 'claude-hook', provenance: 'agent-reported', attribution: 'session',
    observedAt: start + minute * 60_000, kind, paths, evidence: {},
  });
  const events = [event(0, 'session.started'), event(1, 'file.inspected', ['src/api/a.ts']), event(2, 'command.observed'), event(3, 'turn.ended')];
  const fixture = createFixtureBridge().currentSession()!;
  const frame = evaluateFrame(canonicalScript, fixture.graph, 4);
  const child = createElement(IslandMode, { script: canonicalScript, frame, presence: derivePresence(canonicalScript, fixture.graph, frame, false), onPinMini: () => {}, onExpand: () => {}, onViewChanges: () => {} });
  const clock = vi.spyOn(Date, 'now');
  try {
    for (const minute of [2, 3]) {
      const observed = events.slice(0, minute + 1);
      const snapshot = projectSession({ id: 'p', name: 'acme-web' }, observed)!;
      // Real replay projection deliberately cannot carry ordinary commands or turn.ended.
      expect(snapshot.log.events.at(-1)?.kind).toBe('file.read');
      const state = { connected: true, available: true, facts: factsFromEvents(observed, 'p') };
      clock.mockReturnValue(start + minute * 60_000);
      const bridge = { ...createFixtureBridge(), currentSession: () => snapshot, projectPresence: () => state };
      const html = render(bridge, child);
      expect(html).toContain(`Activity observed · 14:0${minute} · Claude hook`);
      expect(html).not.toContain('Read src/api/a.ts');
      expect(html).not.toContain('Checks passed');
    }
  } finally { clock.mockRestore(); }
});
it('older session adapters explicitly identify their last replay event', () => {
  const bridge = createFixtureBridge(); const snapshot = bridge.currentSession()!;
  const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
  const html = render(bridge, createElement(IslandMode, { script: canonicalScript, frame, presence: derivePresence(canonicalScript, snapshot.graph, frame, false), onPinMini: () => {}, onExpand: () => {}, onViewChanges: () => {} }));
  expect(html).toContain('Last replay event · Turn ended');
});
it('idle actions invoke only their explicit callbacks', () => {
  const bridge = createFixtureBridge(null); const open = vi.fn(); const show = vi.fn();
  const context = vi.spyOn(bridgeContext, 'useBridge').mockReturnValue({ ...bridge, showSurface: show });
  const map = vi.spyOn(bridgeContext, 'useProjectMapSnapshot').mockReturnValue(null);
  try {
    const shell = IdleIsland({ onOpen: open });
    const actions = shell.props.children.at(-1).props.children;
    expect(open).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
    expect(actions).toHaveLength(2);
    actions[0].props.onClick(); expect(show.mock.calls).toEqual([['mini']]); expect(open).not.toHaveBeenCalled();
    actions[1].props.onClick(); expect(open).toHaveBeenCalledTimes(1);
  } finally { context.mockRestore(); map.mockRestore(); }
});
it('quiet preview uses the approved waiting copy and two text actions', () => {
  const bridge = createProjectFixtureBridge();
  const companion = deriveCompanionPresence(input, 0, 'UTC');
  const html = render(bridge, createElement(IdleIsland, { companion, onOpen: () => {} }));
  expect(html).toContain('<span class="island__label">Waiting</span>');
  expect(html).toContain('No agent active right now.');
  expect(html).toContain('>Open Mini Player</button>');
  expect(html).toContain('>Open window</button>');
});
it('a relevant failure keeps a short failure caption and its full reason despite recent activity', () => {
  const bridge = createFixtureBridge(); const snapshot = bridge.currentSession()!;
  const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
  const companion = { state: 'failure' as const, label: 'Tests failed · 14:02', description: 'Tests failed · 14:02 · Claude hook', records: [], activeUntil: Date.now() + 1000 };
  const html = render(bridge, createElement(IslandMode, { script: canonicalScript, frame, companion,
    presence: derivePresence(canonicalScript, snapshot.graph, frame, false), onPinMini: () => {}, onExpand: () => {}, onViewChanges: () => {} }));
  expect(html).toContain('<span class="island__label">Tests failed</span>');
  expect(html).toContain(companion.description);
  expect(html).toContain('Last replay event · Turn ended');
  expect(html).toContain('data-presence="failure"');
});
