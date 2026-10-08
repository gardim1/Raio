import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createSimulatedFeedBridge } from '../../platform/fixtureBridge';
import type { Surface } from '../../platform/desktopBridge';
import { freezeClock } from '../../shared/motion/frozenClock';
import { setNativeSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { BOB_TOTAL_SECONDS } from '../raio/bob';
import type { CompanionPresence, PresenceInput } from './companionPresence';
import { runPresenceClock } from './presenceClock';

// Same open simulated session and frozen director as the browser presence fixture.
// Effects do not mount in static markup: drive the real expiry clock explicitly.
afterEach(() => { freezeClock(null); setNativeSurfaceVisible(true); vi.useRealTimers(); });
for (const surface of ['island', 'mini'] as const) {
  it.each(['connected', 'attention', 'failure'] as const)(surface + ' keeps recent text under %s precedence, then shows presence after expiry with the session still open', state => {
    vi.useFakeTimers(); vi.setSystemTime(1000); freezeClock(8); setNativeSurfaceVisible(true);
    const base = createSimulatedFeedBridge({ fixedNowMs: 8000 });
    expect(base.currentSession()!.log.events.some(event => event.kind === 'session.end')).toBe(false);
    const input: PresenceInput = { connected: true, available: true, facts: [
      { id: 'start', sessionId: 'fixture', kind: 'start', at: 1000, source: 'Fixture hook' },
      { id: 'activity', sessionId: 'fixture', kind: 'activity', at: 1000, source: 'Fixture hook' },
      ...(state === 'attention' ? [{ id: 'migration', sessionId: 'fixture', kind: 'change' as const, change: 'added' as const, paths: ['migrations/001_fixture.sql'], at: 1000, source: 'Fixture watcher' }] : []),
      ...(state === 'failure' ? [{ id: 'tests', sessionId: 'fixture', kind: 'check' as const, checkClass: 'tests', result: 'failed' as const, at: 1000, source: 'Fixture check' }] : []),
    ] };
    const bridge = { ...base, fixedSurface: surface as Surface, projectPresence: () => input };
    const seen: { presence: CompanionPresence; html: string; text: string | undefined }[] = [];
    const stop = runPresenceClock({ input, onChange: presence => {
      const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(App) }));
      const className = surface === 'island' ? 'island__label' : 'mini__state';
      const text = html.match(new RegExp('class="' + className + '"[^>]*>([^<]*)<'))?.[1];
      seen.push({ presence, html, text });
    } });
    try {
      expect(seen[0]!.presence.state).toBe(state === 'connected' ? 'working' : state);
      expect(seen[0]!.presence.activeUntil).toBe(1000 + BOB_TOTAL_SECONDS * 1000);
      expect(seen[0]!.text).toBe(surface === 'island' ? state === 'failure' ? 'Tests failed' : 'Claude · Frontend' : 'Claude working');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(BOB_TOTAL_SECONDS * 1000);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.presence.activeUntil).toBeNull();
      expect(seen[1]!.presence.state).toBe(state);
      const expiredCaption = state === 'connected' ? 'Waiting' : seen[1]!.presence.label.replace(/ · \d{2}:\d{2}$/, '');
      expect(seen[1]!.text).toBe(surface === 'island' ? expiredCaption : seen[1]!.presence.label);
      expect(seen[1]!.html).toContain('data-presence="' + state + '"');
      expect(seen[1]!.html).toContain('title="' + seen[1]!.presence.description + '"');
      if (surface === 'mini') expect(seen[1]!.html).toContain('mini__status--working');
      expect(vi.getTimerCount()).toBe(0);
    } finally { stop(); }
  });
}
