import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BridgeProvider } from '../../platform/BridgeContext';
import { createFixtureBridge } from '../../platform/fixtureBridge';
import { IdleIsland } from './IdleIsland';

it('disconnected Island is a focusable preview shell, never a click-to-open button', () => {
  const html = renderToStaticMarkup(createElement(BridgeProvider, { bridge: createFixtureBridge(null), children: createElement(IdleIsland, { onOpen: () => {} }) }));
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('tabindex="0"');
  expect(html).not.toContain('<button type="button" class="island');
});
