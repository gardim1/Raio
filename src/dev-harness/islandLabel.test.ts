import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { BridgeProvider } from '../platform/BridgeContext';
import { createFixtureBridge, createProjectFixtureBridge } from '../platform/fixtureBridge';
import { useSessionUi } from '../features/session/store/sessionStore';
import { freezeClock } from '../shared/motion/frozenClock';

vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { search: '?view=island&t=4&chrome=0' } }));
const { HarnessApp } = await import('./HarnessApp');
const longLabel = 'projeto com espaços e acentos — ' + 'long folder name '.repeat(8);
beforeEach(() => {
  freezeClock(4);
  useSessionUi.setState({ mode: 'island', source: 'live' });
  window.location.search = '?view=island&t=4&chrome=0';
});
afterAll(() => { freezeClock(null); useSessionUi.setState({ mode: 'expanded', source: 'live' }); vi.unstubAllGlobals(); });

it.each([false, true])('opt-in harness label is rendered by React in the real Island path (quiet=%s)', quiet => {
  window.location.search += '&island-label=' + encodeURIComponent(longLabel);
  const bridge = quiet ? createProjectFixtureBridge() : createFixtureBridge();
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge, children: createElement(HarnessApp) }));
  expect(html).toContain(`<span class="island__label">${longLabel}</span>`);
  expect(html).toContain('aria-label="Raio: Demo fixture · ' + longLabel + '"');
  expect(html).toContain('aria-expanded="false"');
});
it('ordinary harness navigation keeps the default Island data without opting into a label fixture', () => {
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge: createProjectFixtureBridge(), children: createElement(HarnessApp) }));
  expect(html).toContain('Connected · quiet');
  expect(html).not.toContain(longLabel);
});
