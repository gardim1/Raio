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
  expect(html).toContain('Open full view'); expect(html).toContain('Open Mini Player');
  if (companion.state !== 'working') expect(html).not.toContain('working');
  if (!state.connected) expect(html).toContain('Choose a project');
  else if (!state.available) expect(html).toContain('Activity status unavailable');
  else if (companion.state === 'connected') expect(html).toContain('Waiting for activity');
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
it('idle actions invoke only their explicit callbacks', () => {
  const bridge = createFixtureBridge(null); const open = vi.fn(); const show = vi.fn();
  const context = vi.spyOn(bridgeContext, 'useBridge').mockReturnValue({ ...bridge, showSurface: show });
  const map = vi.spyOn(bridgeContext, 'useProjectMapSnapshot').mockReturnValue(null);
  try {
    const shell = IdleIsland({ onOpen: open });
    const actions = shell.props.children.at(-1).props.children;
    expect(open).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled();
    actions[0].props.onClick(); expect(open).toHaveBeenCalledTimes(1); expect(show).not.toHaveBeenCalled();
    actions.at(-2).props.onClick(); expect(show.mock.calls).toEqual([['mini']]);
    actions.at(-1).props.onClick(); expect(open).toHaveBeenCalledTimes(2);
  } finally { context.mockRestore(); map.mockRestore(); }
});
