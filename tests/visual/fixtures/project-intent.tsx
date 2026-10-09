/** Synthetic folder intents and connection changes only; no IPC, settings access or filesystem writes. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/app/App';
import { useSessionUi } from '../../../src/features/session/store/sessionStore';
import { BridgeProvider } from '../../../src/platform/BridgeContext';
import type { ConnectedProject, ConnectPreview } from '../../../src/platform/desktopBridge';
import { createProjectFixtureBridge } from '../../../src/platform/fixtureBridge';
import type { ProjectMapBridge } from '../../../src/platform/projectMapBridge';
import { sameProjectRoot } from '../../../src/platform/projectIntent';
import { syncSettingsWriteCount, syncShownProjects } from '../../../src/platform/projectIntentTracker';
import { setNativeSurfaceVisible } from '../../../src/shared/motion/surfaceVisibility';

export const setVisible = setNativeSurfaceVisible;
let releaseChosen: () => void = () => {};
export const resolveChosenPreview = () => releaseChosen();
let releaseUsage: () => void = () => {};
export const resolveUsagePreviews = () => releaseUsage();

export const mountProjectIntentFixture = (options: { connected?: boolean; startupRoot?: string; holdChosenPreview?: boolean; usageConflict?: boolean; holdUsagePreview?: boolean; failPreviewRoot?: string } = {}) => {
  setNativeSurfaceVisible(true);
  let held = options.holdChosenPreview ?? false;
  const pending: (() => void)[] = [];
  const hold = <T,>(value: T): Promise<T> => held ? new Promise(resolve => pending.push(() => resolve(value))) : Promise.resolve(value);
  releaseChosen = () => { held = false; pending.splice(0).forEach(resolve => resolve()); };
  const pendingUsage: (() => void)[] = [];
  releaseUsage = () => pendingUsage.splice(0).forEach(resolve => resolve());
  const base = createProjectFixtureBridge();
  const demo = base.currentProjectMap()!;
  let project: ConnectedProject | null = options.connected ? { id: 'fixture-a', name: 'Fixture A', root: 'C:/fixture/A' } : null;
  let map = project ? { ...demo, project } : null;
  let startup = options.startupRoot ?? null;
  let unavailable = false;
  let writes = 0;
  let releaseOld: () => void = () => {};
  const listeners = new Set<() => void>();
  const intents = new Set<(root: string) => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const preview = (root: string, usage?: { enabled:boolean; replaceExisting:boolean }): ConnectPreview => ({ settingsPath: `${root}/.claude/settings.local.json`, before: '{}', after: '{"hooks":{}}', gitIgnored: true,
    ...(options.usageConflict ? { usage: { enabled:usage?.enabled ?? false, replaceExisting:usage?.replaceExisting ?? false, effective:'user' as const,
      fingerprint:'synthetic-user-status', before:{ type:'command', command:'PRIVATE user command must stay hidden' }, after:usage?.replaceExisting ? { type:'command', command:'raio-hook statusline --raio-managed' } : null,
      reason:usage?.enabled && !usage?.replaceExisting ? 'An existing status line needs explicit project-only replacement consent.' : null } } : {}) });
  const host = document.createElement('div');
  host.id = 'project-intent-fixture';
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#080c16' });
  document.body.append(host);
  const shownProjects: string[] = [];
  const observer = new MutationObserver(() => {
    const name = host.querySelector('.titlebar__project')?.textContent?.trim();
    const output = host.querySelector('[aria-label="Projects shown"]');
    syncShownProjects(shownProjects, name, output);
  });
  observer.observe(host, { childList:true, characterData:true, subtree:true });
  const bridge: ProjectMapBridge = {
    ...base,
    // Exercise the native Expanded launch gate without activating Tauri-only window effects in the browser.
    fixedSurface: 'expanded',
    currentProjectMap: () => map,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    takeProjectIntent: async () => { const value = startup; startup = null; return value; },
    onProjectIntent: async (receive) => { intents.add(receive); return () => { intents.delete(receive); }; },
    selectProject: async (root) => project !== null && sameProjectRoot(project.root, root, true),
    previewProjectMap: (root) => hold(unavailable ? null : { ...demo, project: { id: 'preview-fixture', name: root.split('/').at(-1)! } }),
    connector: {
      project: () => project,
      chooseFolder: async () => 'C:/fixture/new',
      preview: (root, usage) => root === options.failPreviewRoot ? Promise.reject(new Error('Access denied while reviewing this folder.'))
        : root.endsWith('/slow') ? new Promise((resolve) => { releaseOld = () => resolve(preview(root, usage)); })
        : options.holdUsagePreview && usage ? new Promise(resolve => pendingUsage.push(() => resolve(preview(root, usage)))) : hold(preview(root, usage)),
      connect: async (root) => {
        writes++;
        project = { id: 'fixture-new', name: root.split('/').at(-1)!, root };
        map = { ...demo, project };
        syncSettingsWriteCount(host, writes);
        notify();
      },
      disconnect: async () => { project = null; map = null; notify(); },
    },
  };
  const emitIntent = (root: string) => intents.forEach((receive) => receive(root));
  useSessionUi.setState({ mode: 'expanded', source: 'live', selectedNodeId: null, liveRun: 0, replayRun: 0 });
  createRoot(host).render(createElement(BridgeProvider, { bridge, children: createElement('div', null,
    createElement('div', { style: { position: 'fixed', top: 8, left: 8, zIndex: 101 } },
      createElement('span', null, 'Folder intent fixture · no real settings '),
      createElement('output', { 'aria-label':'Projects shown' }, 'none'),
      createElement('output', { 'aria-label': 'Settings writes' }, '0'),
      createElement('button', { onClick: () => emitIntent('c:\\FIXTURE\\a\\') }, 'Intent for connected folder'),
      createElement('button', { onClick: () => emitIntent('C:/fixture/new') }, 'Intent for new folder'),
      createElement('button', { onClick: () => { unavailable = true; } }, 'Make map unavailable'),
      createElement('button', { onClick: () => releaseOld() }, 'Resolve old preview')),
    createElement(App)),
  }));
};
