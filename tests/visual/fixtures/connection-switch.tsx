/** Browser-test-only connection changes; no native IPC, settings access or writes. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionFooter } from '../../../src/features/panel/ConnectionFooter';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import type { ConnectedProject, DesktopBridge } from '../../../src/platform/desktopBridge';
import { createFixtureBridge } from '../../../src/platform/fixtureBridge';

export const mountConnectionSwitchFixture = () => {
  const initial = { id: 'fixture-a', name: 'Fixture A', root: 'fixture-a' };
  let project: ConnectedProject | null = initial;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const bridge: DesktopBridge = {
    ...createFixtureBridge(null),
    projectHooksState: () => 'outdated',
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    connector: {
      project: () => project,
      chooseFolder: () => Promise.resolve(null),
      preview: (root) => Promise.resolve({ settingsPath: `${root}/.claude/settings.local.json`, before: '{}', after: '{"hooks":{}}', gitIgnored: true }),
      connect: () => Promise.reject(new Error('This fixture never writes settings')),
      disconnect: () => { project = null; notify(); return Promise.resolve(); },
    },
  };
  const host = document.createElement('div');
  host.id = 'connection-switch-fixture';
  Object.assign(host.style, { position: 'fixed', top: '60px', left: '60px', zIndex: '100' });
  document.body.append(host);
  const switchTo = (next: ConnectedProject) => { project = next; notify(); };
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement('p', { className: 'evidence__note' }, 'Connection test fixture · no real settings'),
    createElement('button', { onClick: () => switchTo({ id: 'fixture-b', name: 'Fixture B', root: 'fixture-b' }) }, 'Change project id'),
    createElement('button', { onClick: () => switchTo({ ...initial, root: 'fixture-moved' }) }, 'Change project root'),
    createElement('button', { onClick: () => switchTo(initial) }, 'Return project'),
    createElement('aside', { className: 'sidebar', style: { height: 520 } },
      createElement('div', { className: 'sidebar__scroll' }, createElement(ConnectionFooter, { connector: bridge.connector! }))),
  ) }));
};
