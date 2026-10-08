import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { IdleIsland } from './IdleIsland';

it('disconnected Island has a disclosure button and a separate preview with explicit surface actions', () => {
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge: createFixtureBridge(null), children: createElement(IdleIsland, { onOpen: () => {} }) }));
  expect(html).toContain('aria-expanded="false"');
  // Native button focus replaces tabindex on the generic shell; activation is covered by IslandInteraction.
  expect(html).not.toContain('tabindex="0"');
  expect(html).toContain('<button type="button" class="island__trigger island__closed" aria-label="Raio: Disconnected · no project"');
  expect(html).toMatch(/aria-controls="[^"]+"/);
  expect(html).toContain('role="group" aria-label="Island preview"');
  expect(html).toContain('class="island__preview" aria-hidden="true" inert=""');
  expect(html).not.toContain('Give Raio a cookie');
  const triggerEnd = html.indexOf('</button>');
  expect(html).toContain('Choose a project to connect');
  expect(html.indexOf('aria-label="Open Mini Player"')).toBeGreaterThan(triggerEnd);
  expect(html.indexOf('aria-label="Open window"')).toBeGreaterThan(triggerEnd);
});
