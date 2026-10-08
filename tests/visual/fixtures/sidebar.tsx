/** Synthetic sidebar states: no native IPC, filesystem access or real settings. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { projectMap } from '../../../src/features/project/projectMap';
import { useSessionUi } from '../../../src/features/session/store/sessionStore';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import type { ConnectedProject } from '../../../src/platform/desktopBridge';
import { createFixtureBridge } from '../../../src/platform/fixtureBridge';
import type { ProjectMapBridge } from '../../../src/platform/projectMapBridge';
import { setNativeSurfaceVisible } from '../../../src/shared/motion/surfaceVisibility';

export type SidebarFixtureState = 'pending' | 'empty' | 'unrecognized' | 'partial' | 'skipped' | 'stale' | 'unavailable' | 'denied' | 'mapped' | 'health' | 'outdated' | 'disconnected' | 'session' | 'replay';
export const longFolderName = 'Pasta com acentos ação e espaços ' + 'muito longa '.repeat(8);
export const mountSidebarFixture = (state: SidebarFixtureState) => {
  setNativeSurfaceVisible(true);
  for (const child of document.body.children) if (child instanceof HTMLElement) child.inert = true;
  const host = document.createElement('div'); host.id = 'sidebar-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#080c16' });
  document.body.append(host);
  let project: ConnectedProject | null = state === 'disconnected' ? null : { id: 'sidebar-fixture', name: longFolderName, root: 'C:/fixture/original' };
  const nullListing = ['pending', 'unavailable', 'denied'].includes(state);
  let snapshot = projectMap({ id: 'sidebar-fixture', name: longFolderName }, nullListing ? null : {
    files: ['empty', 'partial', 'skipped', 'stale'].includes(state) ? [] : state === 'unrecognized' ? ['readme.md'] : ['package.json', 'src/api/a.ts'],
    manifests: [], truncated: state === 'partial', skipped: state === 'skipped' ? 2 : 0, scannedAtMs: 1,
  }, null, { provenance: 'fixture', pending: state === 'pending', inventoryStale: state === 'stale',
    unavailableReason: state === 'denied' ? 'Access denied by the filesystem' : undefined,
    core: { dropped: state === 'health' ? 3 : 0, watcherOverflow: state === 'health', historyResetFrom: state === 'health' ? 'fixture-backup' : null, hookBinary: state === 'health' ? null : 'raio-hook' },
  });
  const fixtureSession = createFixtureBridge().currentSession()!;
  const session = state === 'session' || state === 'replay' ? { ...fixtureSession, project: longFolderName, log: { ...fixtureSession.log, project: longFolderName }, evidence: {
    note: snapshot.note + ' The scan was partial, so some relationships may be missing.', relationships: 'unknown' as const,
    parallel: false, actors: 1, reportedEdits: [], unassigned: [], validations: [], technologies: ['Frontend · Next.js'],
  } } : null;
  let writes = 0, disconnects = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const counts = () => { host.querySelector('output')!.textContent = `${writes} writes · ${disconnects} disconnects`; };
  const bridge: ProjectMapBridge = {
    ...createFixtureBridge(null), fixedSurface: 'expanded',
    currentSession: () => session,
    currentProjectMap: () => project && !session ? snapshot : null,
    projectHooksState: () => state === 'outdated' ? 'outdated' : 'current',
    previewProjectMap: async () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    connector: {
      project: () => project,
      chooseFolder: async () => 'C:/fixture/another',
      preview: async root => ({ settingsPath: `${root}/.claude/settings.local.json`, before: '{}', after: '{"hooks":{}}', gitIgnored: true }),
      connect: async root => { writes++; project = { id: 'another', name: 'another', root }; snapshot = { ...snapshot, project }; counts(); notify(); },
      disconnect: async () => { disconnects++; project = null; counts(); notify(); },
    },
  };
  useSessionUi.setState({ mode: 'expanded', source: state === 'replay' ? 'replay' : 'live', selectedNodeId: null, liveRun: 0, replayRun: 0 });
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement('output', { 'aria-label': 'Synthetic settings actions', style: { position: 'fixed', top: 8 } }, '0 writes · 0 disconnects'),
    createElement(App)),
  }));
};
