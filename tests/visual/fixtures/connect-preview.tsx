/** Native-sized Connect layout with synthetic data and injected window actions; no IPC or settings writes. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ExpandedConnectView } from '../../../src/app/App';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import { createProjectFixtureBridge } from '../../../src/platform/fixtureBridge';
import { setNativeSurfaceVisible } from '../../../src/shared/motion/surfaceVisibility';
import '../../../src/platform/native.css';

let updateMaximized = (_value: boolean) => {};
export const setFixtureMaximized = (value: boolean) => updateMaximized(value);

export const mountConnectPreviewFixture = (initialRoot?: string, initialMaximized = false) => {
  setNativeSurfaceVisible(true);
  document.documentElement.classList.add('native', 'surface-expanded');
  const host = document.createElement('div');
  host.id = 'connect-preview-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#080c16' });
  document.body.append(host);
  const base = createProjectFixtureBridge();
  const demo = base.currentProjectMap()!;
  const calls = { drag: 0, maximize: 0, minimize: 0, close: 0, connect: 0 };
  const record = async (action: keyof typeof calls) => {
    calls[action]++;
    host.querySelector('output')!.textContent = JSON.stringify(calls);
  };
  const bridge = {
    ...base,
    currentProjectMap: () => null,
    previewProjectMap: async (root: string) => ({ ...demo, project: { id: 'preview', name: root.split('/').at(-1)! } }),
    connector: {
      project: () => null,
      chooseFolder: async () => 'C:/fixture/Chosen folder',
      preview: async (root: string) => ({ settingsPath: root + '/.claude/settings.local.json', before: '{}', after: '{"hooks":{}}', gitIgnored: true }),
      connect: async () => record('connect'),
      disconnect: async () => {},
    },
  };
  let maximized = initialMaximized;
  const resizeListeners = new Set<() => void>();
  updateMaximized = value => { maximized = value; resizeListeners.forEach(listener => listener()); };
  const windowApi = {
    startDragging: () => record('drag'),
    toggleMaximize: async () => { updateMaximized(!maximized); await record('maximize'); },
    minimize: () => record('minimize'), close: () => record('close'),
    isMaximized: async () => maximized,
    onResized: async (callback: () => void) => { resizeListeners.add(callback); return () => { resizeListeners.delete(callback); }; },
  };
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement(ExpandedConnectView, { connector: bridge.connector, initialRoot, windowApi }),
    createElement('output', { 'aria-label': 'Fixture actions', style: { position: 'fixed', bottom: 0, right: 0, pointerEvents: 'none' } }, JSON.stringify(calls)),
  ) }));
};
