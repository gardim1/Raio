import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as product from './App';
import { BridgeProvider } from '../platform/BridgeContext';
import { createFixtureBridge } from '../platform/fixtureBridge';
import type { DesktopBridge } from '../platform/desktopBridge';

const windowApi = { close: async () => {}, minimize: async () => {}, toggleMaximize: async () => {}, startDragging: async () => {} };
const bridgeFor = (kind: DesktopBridge['kind']): DesktopBridge => ({
  ...createFixtureBridge(null), kind, fixedSurface: 'expanded',
  connector: { project: () => null, chooseFolder: async () => null, preview: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
});
const render = (bridge: DesktopBridge, children: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(BridgeProvider, { bridge, children }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Expanded connection chrome', () => {
  it('keeps all window controls in the actual native empty Expanded flow', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    vi.mocked(getCurrentWindow).mockReturnValue(windowApi as ReturnType<typeof getCurrentWindow>);
    const bridge = bridgeFor('native');
    const html = render(bridge, createElement(product.App));
    expect(html).toContain('titlebar--native');
    for (const label of ['Close window', 'Minimize window', 'Maximize or restore window']) expect(html).toContain('aria-label="' + label + '"');
    expect(html).toContain('Choose a folder');
    expect(html).not.toContain('Unknown agent');
    expect(html).toContain('data-presence="disconnected"');
    expect(bridge.connector!.connect).not.toHaveBeenCalled();
  });
  it('keeps native chrome and the chosen folder on the initial intent preview without connecting', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    vi.mocked(getCurrentWindow).mockReturnValue(windowApi as ReturnType<typeof getCurrentWindow>);
    expect(product.ExpandedConnectView).toBeTypeOf('function');
    const bridge = bridgeFor('native');
    const html = render(bridge, createElement(product.ExpandedConnectView, { connector: bridge.connector!, initialRoot: 'C:/fixture/New folder', onClose: () => {} }));
    expect(html).toContain('titlebar--native');
    expect(html).toContain('aria-label="Close window"');
    expect(html).toContain('Reviewing C:/fixture/New folder');
    expect(html).toContain('New folder');
    expect(html).toContain('Cancel');
    expect(bridge.connector!.connect).not.toHaveBeenCalled();
  });
  it('keeps browser chrome decorative and does not access the native window API', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    const bridge = bridgeFor('fixture');
    const html = render(bridge, createElement(product.App));
    expect(html).toContain('class="titlebar__dots" aria-hidden="true"');
    expect(html).not.toContain('aria-label="Close window"');
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });
});
