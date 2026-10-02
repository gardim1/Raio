import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { RaioEvent } from '../features/ingest/raioEvent';
import { isProjectImports, type ProjectImports } from '../features/project/importEdges';
import { projectSessionDetailed } from '../features/project/projectSession';
import type { ConnectedProject, ConnectPreview, Connector, CoreHealth, DesktopBridge, SessionSnapshot, Surface } from './desktopBridge';

const SURFACES: readonly Surface[] = ['island', 'mini', 'expanded'];

/** The surface a native window was opened for (`?surface=`). */
export const surfaceFromUrl = (search: string): Surface | null => {
  const s = new URLSearchParams(search).get('surface');
  return SURFACES.find((x) => x === s) ?? null;
};

/** Minimal IPC surface, injectable for tests. */
export interface NativeIpc {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  onIngested(listener: () => void): void;
  chooseFolder(): Promise<string | null>;
}

const tauriIpc: NativeIpc = {
  invoke: (command, args) => invoke(command, args),
  onIngested: (listener) => void listen('events-ingested', listener),
  chooseFolder: async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Choose a project folder to connect' });
    return typeof picked === 'string' ? picked : null;
  },
};

/**
 * Pulls (and clears) the intent the core holds for the calling window, e.g. "replay". The core uses
 * the calling window, so there are no arguments. Anything but a string is treated as "no intent".
 */
export const takeSurfaceIntent = async (ipc: Pick<NativeIpc, 'invoke'> = tauriIpc): Promise<string | null> => {
  const intent = await ipc.invoke<unknown>('take_surface_intent');
  return typeof intent === 'string' ? intent : null;
};

/** The import scan reads the project, so it is repeated at most this often, and only after file activity. */
const SCAN_INTERVAL_MS = 10_000;
/** A scan that has not answered by now is given up on, so a hung call never blocks the next one. */
const SCAN_TIMEOUT_MS = 5_000;

const isFileActivity = (event: RaioEvent): boolean => event.kind === 'file.changed' || event.kind === 'file.edit.reported';

/** Resolves `null` when `work` has not settled within `ms` (its late answer is the caller's to ignore). */
const withinTime = <T,>(work: Promise<T | null>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      () => (clearTimeout(timer), resolve(null)),
    );
  });

/**
 * Bridge to the Tauri core: reads the persisted events of the connected project and projects the
 * latest session (provenance 'live'). With no connected project or no agent events it reports null,
 * so the surfaces show the empty state instead of demo data. Relationships between areas come from the core's
 * static import scan (`project_imports`), which never delays the session: until it answers, fails, times out or
 * returns something malformed, the map has no edges and says relationships are unknown. Only the surfaces that
 * draw the map (Mini Player, Expanded) scan; a project change or a timeout releases the scan slot.
 */
export const createNativeBridge = (
  fixedSurface: Surface,
  ipc: NativeIpc = tauriIpc,
  clock: () => number = Date.now,
  scanTimeoutMs: number = SCAN_TIMEOUT_MS,
): DesktopBridge => {
  const report = (command: string) => (error: unknown) => console.error(`[raio] ${command} failed`, error);
  const listeners = new Set<() => void>();
  let snapshot: SessionSnapshot | null = null;
  let project: ConnectedProject | null = null;
  let refreshing: Promise<void> | null = null;
  let dirty = false;
  // The latest accepted import scan, for the connected project it was taken from.
  const drawsMap = fixedSurface !== 'island';
  let scanKey: string | null = null;
  let imports: ProjectImports | null = null;
  let importsStale = false;
  /** Identifies the scan whose answer may still be applied; a project change or a newer scan retires the others. */
  let scanToken = 0;
  let scanning = false;
  let scanActivity = -1;
  let scanStartedAt = 0;
  let scanFailureReported = false;

  const scanImports = async (projectId: string): Promise<ProjectImports | null> => {
    try {
      const value = await ipc.invoke<unknown>('project_imports', { projectId });
      return isProjectImports(value) ? value : null;
    } catch (error) {
      if (!scanFailureReported) {
        scanFailureReported = true;
        report('project_imports')(error);
      }
      return null;
    }
  };

  /** Starts a scan when none has run for this project, or when file activity arrived and the interval has passed. */
  const scanIfDue = (current: ConnectedProject, events: readonly RaioEvent[]): void => {
    if (!drawsMap) return;
    const activity = events.filter(isFileActivity).length;
    const due = scanActivity < 0 || (activity !== scanActivity && clock() - scanStartedAt >= SCAN_INTERVAL_MS);
    if (scanning || !due) return;
    scanning = true;
    scanActivity = activity;
    scanStartedAt = clock();
    const token = ++scanToken;
    void withinTime(scanImports(current.id), scanTimeoutMs).then((result) => {
      if (token !== scanToken) return; // the project changed meanwhile, or a newer scan took over
      scanning = false;
      if (result) {
        imports = result;
        importsStale = false;
        void refresh();
      } else if (imports && !importsStale) {
        // A rescan failed: the map keeps the last good scan, labelled as of then.
        importsStale = true;
        void refresh();
      }
    });
  };

  /** Coalesces refreshes; a notification that arrives during one schedules exactly one more. */
  const refresh = (): Promise<void> => {
    if (refreshing) {
      dirty = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        const health = await ipc.invoke<CoreHealth | undefined>('core_status').catch(() => undefined);
        const projects = await ipc.invoke<ConnectedProject[]>('list_projects');
        const current = projects[0] ?? null;
        const events = current ? await ipc.invoke<RaioEvent[]>('project_events', { projectId: current.id }) : [];
        const key = current ? `${current.id}|${current.root}` : null;
        if (key !== scanKey) {
          scanKey = key;
          imports = null;
          importsStale = false;
          scanActivity = -1;
          scanning = false;
          scanToken++; // an answer still on its way belongs to the previous project
        }
        const projected = current ? projectSessionDetailed(current, events, undefined, imports, importsStale) : null;
        project = current && project?.id === current.id && project.root === current.root ? project : current;
        snapshot = projected ? { ...projected.snapshot, evidence: projected.insights, ...(health ? { core: health } : {}) } : null;
        listeners.forEach((l) => l());
        if (current && projected) scanIfDue(current, events);
      } catch (error) {
        report('refresh')(error);
      } finally {
        refreshing = null;
        if (dirty) {
          dirty = false;
          void refresh();
        }
      }
    })();
    return refreshing;
  };
  ipc.onIngested(() => void refresh());
  void refresh();

  const connector: Connector = {
    project: () => project,
    chooseFolder: () => ipc.chooseFolder(),
    preview: (root) => ipc.invoke<ConnectPreview>('preview_connect', { root }),
    connect: async (root, previewed) => {
      await ipc.invoke('connect_project', { root, previewed });
      await refresh();
    },
    disconnect: async () => {
      if (!project) return;
      await ipc.invoke('disconnect_project', { projectId: project.id });
      await refresh();
    },
  };

  return {
    kind: 'native',
    fixedSurface,
    currentSession: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showSurface: (surface, intent) => void ipc.invoke('show_surface', { surface, intent: intent ?? null }).catch(report('show_surface')),
    setPinned: (pinned) => void ipc.invoke('set_always_on_top', { surface: 'mini', onTop: pinned }).catch(report('set_always_on_top')),
    setIslandHitRect: (rect) => void ipc.invoke('set_island_hit_rect', { rect }).catch(report('set_island_hit_rect')),
    projectImports: () => Promise.resolve(imports),
    connector,
  };
};
