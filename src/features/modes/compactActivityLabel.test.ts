import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { canonicalScript } from '../session/model/canonicalScript';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { deriveCompanionPresence, type PresenceInput } from './companionPresence';
import { BOB_TOTAL_SECONDS } from '../raio/bob';
import { IslandMode } from './IslandMode';
import { MiniPlayer } from './MiniPlayer';
import { derivePresence } from './presence';

const bridge = createFixtureBridge();
const snapshot = bridge.currentSession()!;
const attentionInput: PresenceInput = { connected: true, available: true, facts: [
  { id: 'migration', kind: 'change', change: 'added', paths: ['migrations/001_fixture.sql'], at: 0, source: 'Fixture watcher' },
] };
const failureInput: PresenceInput = { connected: true, available: true, facts: [
  { id: 'tests', kind: 'check', checkClass: 'tests', result: 'failed', at: 0, source: 'Fixture check' },
] };
const attention = deriveCompanionPresence(attentionInput, 1000, 'UTC');
const failure = deriveCompanionPresence(failureInput, 1000, 'UTC');
const activityInput: PresenceInput = { connected: true, available: true, facts: [{ id: 'read', sessionId: 'open', kind: 'activity', at: 0, source: 'Fixture read' }] };
const recent = deriveCompanionPresence(activityInput, 1000, 'UTC');
const quiet = deriveCompanionPresence(activityInput, BOB_TOTAL_SECONDS * 1000, 'UTC');
const expiredAttention = deriveCompanionPresence(attentionInput, BOB_TOTAL_SECONDS * 1000, 'UTC');
const expiredFailure = deriveCompanionPresence(failureInput, BOB_TOTAL_SECONDS * 1000, 'UTC');
const noop = () => {};
const compactText = (html: string, surface: 'island' | 'mini') =>
  html.match(new RegExp('class="' + (surface === 'island' ? 'island__label' : 'mini__state') + '"[^>]*>([^<]*)<'))?.[1];

for (const surface of ['island', 'mini'] as const) {
  describe(surface + ' compact live label', () => {
    const render = (t: number, companion: typeof attention, stateLabel?: string) => {
      const frame = evaluateFrame(canonicalScript, snapshot.graph, t);
      const props = { script: canonicalScript, frame, companion, presence: derivePresence(canonicalScript, snapshot.graph, frame, false), onExpand: noop, onViewChanges: noop };
      const children = surface === 'island'
        ? createElement(IslandMode, { ...props, onPinMini: noop })
        : createElement(MiniPlayer, { ...props, graph: snapshot.graph, project: snapshot.project, pinned: false, onTogglePin: noop, onCollapse: noop, ...(stateLabel ? { stateLabel } : {}) });
      return renderToStaticMarkup(createElement(BridgeProvider, { bridge, children }));
    };

    it.each([attention, failure])('keeps the original working text with $state precedence and accessible evidence', companion => {
      const html = render(4, companion);
      expect(compactText(html, surface)).toBe(surface === 'island' ? companion.state === 'failure' ? 'Tests failed' : 'Claude · API' : 'Claude working');
      expect(html).toContain('data-presence="' + companion.state + '"');
      const description = surface === 'island' && companion.state !== 'failure' ? 'Claude · API · ' + companion.description : companion.description;
      expect(html).toContain('aria-label="' + (surface === 'island' ? 'Raio: ' : '') + description + '"');
      expect(html).toContain('title="' + description + '"');
    });

    it.each([expiredAttention, expiredFailure])('shows $state presence copy after activity expires, even with a working frame', companion => {
      const html = render(4, companion);
      expect(compactText(html, surface)).toBe(surface === 'island' ? companion.label.replace(/ · \d{2}:\d{2}$/, '') : companion.label);
      expect(html).toContain('data-presence="' + companion.state + '"');
      expect(html).toContain('title="' + companion.description + '"');
    });

    if (surface === 'mini') it('keeps the replay label while presence evidence remains accessible', () => {
      const html = render(4, failure, 'Replay');
      expect(compactText(html, surface)).toBe('Replay');
      expect(html).toContain('title="' + failure.description + '"');
    });
    if (surface === 'mini') it('preserves an explicit working session label exactly', () => {
      expect(compactText(render(4, attention, 'Live session · 14:02'), surface)).toBe('Live session · 14:02');
    });
  });
}

describe('Island activity without a mapped area', () => {
  const render = (companion: typeof attention) => {
    const frame = evaluateFrame(canonicalScript, snapshot.graph, 4);
    const presence = { ...derivePresence(canonicalScript, snapshot.graph, frame, false), activeNodeLabel: null };
    return renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(IslandMode, {
      script: canonicalScript, frame: { ...frame, ui: { ...frame.ui, activeNodeId: null } },
      presence, companion, onPinMini: noop, onExpand: noop, onViewChanges: noop,
    }) }));
  };
  it.each([recent, quiet, attention, failure, expiredAttention, expiredFailure])('uses current $state evidence instead of an indefinite starting label', companion => {
    const html = render(companion);
    const caption = companion.state === 'connected' ? 'Waiting' : companion.label.replace(/ · \d{2}:\d{2}$/, '');
    expect(compactText(html, 'island')).toBe(caption);
    expect(html).toContain('aria-label="Raio: ' + companion.description + '"');
    expect(html).toContain('title="' + companion.description + '"');
    expect(html).not.toContain('Claude · starting');
  });
});
