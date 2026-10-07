import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge, createSimulatedFeedBridge } from '../../platform/fixtureBridge';
import type { Surface } from '../../platform/desktopBridge';
import { fallbackPresenceInput } from './presenceClock';

describe('presence wiring in actual product surfaces', () => {
  it.each<Surface>(['island', 'mini', 'expanded'])('shows factual failure and its source in %s, independent of animation completion', surface => {
    const base = createFixtureBridge();
    const bridge = { ...base, fixedSurface: surface, projectPresence: () => ({ connected: true, available: true, facts: [{ id: 'f', kind: 'check' as const, at: 0, checkClass: 'tests', result: 'failed' as const, source: 'Demo fixture check' }] }) };
    const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(App) }));
    expect(html).toContain('data-presence="failure"');
    expect(html).toContain('Tests failed');
    expect(html).toContain('Demo fixture check');
  });
  it('fallback uses only log evidence and explicitly labels demo provenance; absent health is unavailable', () => {
    const snapshot = createFixtureBridge().currentSession()!;
    const fixture = fallbackPresenceInput(snapshot, null, true);
    expect(fixture.connected).toBe(true); expect(fixture.available).toBe(true);
    expect(fixture.facts.length).toBeGreaterThan(0);
    expect(fixture.facts.every(fact => fact.source === 'Demo fixture')).toBe(true);
    expect(fallbackPresenceInput(null, null, false)).toMatchObject({ connected: false, available: false, facts: [] });
    expect(fallbackPresenceInput({ ...snapshot, provenance: 'live' }, null, false).available).toBe(false);
  });
});

it.each(['expanded', 'mini'] as const)('labels the actual open %s session in progress and the recorded end complete', surface => {
  const open = createSimulatedFeedBridge({ fixedNowMs: 8000 });
  const ended = createSimulatedFeedBridge({ fixedNowMs: 36_000 });
  const render = (base: ReturnType<typeof createFixtureBridge>) => renderToStaticMarkup(createElement(BridgeProvider, { bridge: { ...base, fixedSurface: surface }, children: createElement(App) }));
  expect(render(open)).toContain('Session in progress');
  expect(render(open)).not.toContain('Partial (no end recorded)');
  expect(render(ended)).toContain('Complete (end recorded)');
});

it('retains superseded failure evidence with reduced emphasis in the actual inspector', () => {
  const base = createFixtureBridge();
  const bridge = { ...base, fixedSurface: 'expanded' as const, projectPresence: () => ({ connected: true, available: true, facts: [
    { id: 'f', kind: 'check' as const, at: 0, checkClass: 'tests', result: 'failed' as const, source: 'Demo fixture check' },
    { id: 'c', kind: 'change' as const, at: 1, paths: ['src/demo.ts'], source: 'Demo fixture watcher' },
  ] }) };
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(App) }));
  expect(html).not.toContain('data-presence="failure"');
  expect(html).toContain('data-presence="connected"');
  expect(html).toContain('presence-record--historical');
  expect(html).toContain('Failed earlier · code changed since');
  expect(html).toContain('Demo fixture check');
});
