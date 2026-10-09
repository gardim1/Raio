import { demoGraph } from '../features/architecture/model/demoProject';
import { connectNodes, createGraph } from '../features/architecture/model/graph';
import { deriveImportEdges, drawnLinks } from '../features/project/importEdges';
import type { SessionLog } from '../features/session/model/events';
import { demoSessionLog } from '../features/session/model/demoSession';
import { useSessionUi } from '../features/session/store/sessionStore';
import { demoGroupOf, demoImportFacts, demoInventory } from './demoImports';
import type { ConnectPreview, DesktopBridge, IntegrationStatus, ProjectHooksState, SessionSnapshot } from './desktopBridge';
import type { ProjectMapBridge } from './projectMapBridge';
import { projectMap } from '../features/project/projectMap';
import { isWindowsRoot, sameProjectRoot } from './projectIntent';
import type { ClaudeUsageState } from '../features/usage/claudeUsage';

/** Dev harness only, explicitly synthetic. Product pages and product builds always return disabled. */
const fixtureUsage = (): ClaudeUsageState => {
  if (!import.meta.env.DEV || !globalThis.location?.pathname.endsWith('/harness.html')) return { status: 'disabled' };
  const mode = new URLSearchParams(globalThis.location.search).get('usage');
  if (mode === 'waiting') return { status: 'waiting' };
  if (mode === 'incompatible') return { status: 'incompatible', reason: 'DEMO · Existing status line needs project-only replacement consent.' };
  if (!mode || !['reading', 'stale', 'missing-weekly', 'expired'].includes(mode)) return { status: 'disabled' };
  const now = Date.now();
  return { status: 'reading', sourceCount: 1, latest: {
    source: { kind: 'claude-statusline', projectId: 'DEMO-project', sessionId: 'DEMO-session', claudeVersion: 'DEMO' },
    receivedAtMs: now - (mode === 'stale' ? 20 * 60_000 : 60_000),
    fiveHour: { usedPercentage: 42, resetsAtMs: now + (mode === 'expired' ? -60_000 : 2 * 60 * 60_000) },
    ...(mode === 'missing-weekly' ? {} : { sevenDay: { usedPercentage: 68, resetsAtMs: now + 3 * 24 * 60 * 60_000 } }),
  } };
};
const fixtureIntegrations: Readonly<Record<IntegrationStatus['hooks'], IntegrationStatus>> = {
  current:{ hooks:'current', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null },
  outdated:{ hooks:'outdated', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null },
  missing:{ hooks:'missing', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null },
  unknown:{ hooks:'unknown', hookBinary:true, heartbeatAgeMs:60_000, inertMarkerAt:null, lastHookEventAt:null, lastHookSessionId:null, lastWatcherChangeAt:null },
};
export const fixtureIntegrationStatus = (hooks: IntegrationStatus['hooks'] = 'current'): IntegrationStatus => fixtureIntegrations[hooks];

/** The demo session behind the approved concept. Always labelled as a fixture. */
export const demoSnapshot: SessionSnapshot = {
  provenance: 'fixture',
  project: demoSessionLog.project,
  graph: demoGraph,
  log: demoSessionLog,
};

const showSurfaceInPlace: DesktopBridge['showSurface'] = (surface, intent) => {
  const ui = useSessionUi.getState();
  ui.setMode(surface);
  if (intent === 'replay') ui.startReplay();
};

/** A static bridge for the browser, tests and the dev harness. Never reports live data. */
export const createFixtureBridge = (snapshot: SessionSnapshot | null = demoSnapshot): DesktopBridge => {
  if (snapshot && snapshot.provenance !== 'fixture') {
    throw new Error('Fixture bridge only serves fixture data');
  }
  const current = snapshot?.core
    ? { ...snapshot, core: { ...snapshot.core, droppedAtLeast: snapshot.core.droppedAtLeast ?? false } }
    : snapshot;
  const usage = fixtureUsage();
  return {
    kind: 'fixture',
    fixedSurface: null,
    currentSession: () => current,
    takeProjectIntent: () => Promise.resolve(null),
    onProjectIntent: () => Promise.resolve(() => {}),
    selectProject: () => Promise.resolve(false),
    previewProjectMap: (root) => Promise.resolve(projectMap({ id: 'preview-fixture', name: root.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? root }, demoInventory, demoImportFacts, { provenance: 'fixture' })),
    projectHooksState: () => 'current',
    integrationStatus: () => fixtureIntegrationStatus(),
    claudeUsage: () => usage,
    subscribe: () => () => {},
    showSurface: showSurfaceInPlace,
    setPinned: () => {},
    setIslandHitRect: () => {},
    onIslandPointer: () => Promise.resolve(() => {}),
    projectImports: () => Promise.resolve(demoImportFacts),
    projectInventory: () => Promise.resolve(demoInventory),
    connector: null,
  };
};

/** Development-only project map before any session; the map is explicitly labelled as fixture data. */
export const createProjectFixtureBridge = (options: { hooksState?: ProjectHooksState } = {}): ProjectMapBridge => {
  const snapshot = projectMap({ id: 'demo-project', name: demoSessionLog.project }, demoInventory, demoImportFacts, { provenance: 'fixture' });
  if (options.hooksState === undefined) return { ...createFixtureBridge(null), currentProjectMap: () => snapshot, integrationStatus: () => fixtureIntegrationStatus() };
  // Opt-in harness connection: entirely in memory, always labelled as a fixture. Never calls native IPC or disk.
  const project = { ...snapshot.project, root: 'demo-project' };
  let connected = true;
  let hooksState = options.hooksState;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const preview: ConnectPreview = {
    settingsPath: 'demo-project/.claude/settings.local.json',
    before: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'raio-hook (demo)' }] }] } }),
    after: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'raio-hook (demo)' }] }] } }),
    gitIgnored: true,
  };
  return {
    ...createFixtureBridge(null),
    currentProjectMap: () => connected ? snapshot : null,
    selectProject: (root) => Promise.resolve(connected && sameProjectRoot(project.root, root, isWindowsRoot(project.root))),
    projectHooksState: () => connected ? hooksState : 'unknown',
    integrationStatus: () => fixtureIntegrationStatus(connected ? hooksState : 'unknown'),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    connector: {
      project: () => connected ? project : null,
      chooseFolder: () => Promise.resolve(null),
      preview: () => Promise.resolve(preview),
      connect: () => { connected = true; hooksState = 'current'; notify(); return Promise.resolve(); },
      disconnect: () => { connected = false; notify(); return Promise.resolve(); },
    },
  };
};

/* Simulated live feed (development and tests only) ---------------------------------------- */

/** How the demo session's events reach the simulated feed. */
export type SimulatedFeedPace = 'steady' | 'burst';

/** The demo session's 14½ minutes compressed ~30× onto the feed's clock. */
const STEADY_SCALE = 1 / 30;

/** `arrivalMs[i]` for `log.events[i]`. `steady`: the session's own rhythm, sped up. `burst`: two events, a pause, then ten at once. */
export const feedArrivals = (log: SessionLog, pace: SimulatedFeedPace): number[] => {
  if (pace === 'steady') return log.events.map((e) => Math.round(e.atMs * STEADY_SCALE));
  return log.events.map((_, i) => (i < 2 ? i * 400 : 2000 + (i - 2) * 30));
};

export interface SimulatedFeedOptions {
  readonly log?: SessionLog;
  readonly pace?: SimulatedFeedPace;
  /** Explicit arrival times, overriding `pace`. */
  readonly arrivalMs?: readonly number[];
  /**
   * Fixed clock: serve exactly the events that had arrived at this feed time and never schedule anything.
   * Omit to follow the wall clock from creation.
   */
  readonly fixedNowMs?: number;
}

/**
 * The map the live product draws: the demo's systems, with edges only where the demo's import facts have a
 * static import between two of them (the same derivation as live data; the film's hand-drawn relationships are not used).
 */
const feedGraph = createGraph(
  demoGraph.nodes,
  connectNodes(
    demoGraph.nodes,
    drawnLinks(deriveImportEdges(demoImportFacts, demoGroupOf).edges),
  ),
);

/**
 * Dev/test bridge that appends a demo session's events over time, like a real agent would. It stays a
 * `fixture` (labelled as such); the director consumes it exactly like live data.
 */
export const createSimulatedFeedBridge = (options: SimulatedFeedOptions = {}): DesktopBridge => {
  const log = options.log ?? demoSessionLog;
  const arrivalMs = options.arrivalMs ?? feedArrivals(log, options.pace ?? 'steady');
  const listeners = new Set<() => void>();
  const cache = new Map<number, SessionSnapshot>();
  const arrivedBy = (nowMs: number): number => arrivalMs.filter((a) => a <= nowMs).length;

  const snapshotFor = (count: number): SessionSnapshot => {
    let snapshot = cache.get(count);
    if (!snapshot) {
      snapshot = {
        provenance: 'fixture',
        project: log.project,
        graph: feedGraph,
        log: { ...log, events: log.events.slice(0, count) },
        simulatedFeed: { arrivalMs: arrivalMs.slice(0, count) },
      };
      cache.set(count, snapshot);
    }
    return snapshot;
  };

  let count = arrivedBy(options.fixedNowMs ?? 0);
  const usage = fixtureUsage();
  if (options.fixedNowMs === undefined) {
    const startedAt = performance.now();
    const schedule = (): void => {
      const next = arrivalMs[count];
      if (next === undefined) return;
      setTimeout(() => {
        count = arrivedBy(performance.now() - startedAt);
        listeners.forEach((l) => l());
        schedule();
      }, Math.max(0, next - (performance.now() - startedAt)));
    };
    schedule();
  }

  return {
    kind: 'fixture',
    fixedSurface: null,
    currentSession: () => (count > 0 ? snapshotFor(count) : null),
    takeProjectIntent: () => Promise.resolve(null),
    onProjectIntent: () => Promise.resolve(() => {}),
    selectProject: () => Promise.resolve(false),
    previewProjectMap: (root) => Promise.resolve(projectMap({ id: 'preview-fixture', name: root.split('/').at(-1) ?? root }, demoInventory, demoImportFacts, { provenance: 'fixture' })),
    projectHooksState: () => 'current',
    integrationStatus: () => fixtureIntegrationStatus(),
    claudeUsage: () => usage,
    subscribe: (listener) => {
      // Usage demos are static; only the simulated session feed schedules notifications.
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showSurface: showSurfaceInPlace,
    setPinned: () => {},
    setIslandHitRect: () => {},
    onIslandPointer: () => Promise.resolve(() => {}),
    projectImports: () => Promise.resolve(demoImportFacts),
    projectInventory: () => Promise.resolve(demoInventory),
    connector: null,
  };
};
