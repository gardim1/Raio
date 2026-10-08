import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';
import type { RaioEvent } from '../features/ingest/raioEvent';
import { isProjectImports, type ProjectImports } from '../features/project/importEdges';
import { isProjectInventory, type ProjectInventory } from '../features/project/projectInventory';
import { projectSessionDetailed } from '../features/project/projectSession';
import { projectMap, type ProjectMapSnapshot } from '../features/project/projectMap';
import type { ProjectMapBridge } from './projectMapBridge';
import { isWindowsRoot, sameProjectRoot } from './projectIntent';
import { factsFromEvents } from '../features/modes/presenceFacts';
import type { PresenceInput } from '../features/modes/companionPresence';
import type { ConnectedProject, ConnectPreview, Connector, CoreHealth, ProjectHooksState, SessionSnapshot, Surface } from './desktopBridge';

/** One app-local UI preference shared by webviews, including lazily created windows. */
const SELECTED_ROOT_KEY = 'raio.selected-project-root';
const readSelectedRoot = (): string | null => {
  try { return globalThis.localStorage?.getItem(SELECTED_ROOT_KEY) || null; } catch { return null; }
};
const saveSelectedRoot = (root: string): void => {
  try { globalThis.localStorage?.setItem(SELECTED_ROOT_KEY, root); } catch { /* Existing windows still receive the selection event. */ }
};

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
  onIslandPointer?(listener: (inside: boolean) => void): Promise<() => void>;
  chooseFolder(): Promise<string | null>;
  onProjectIntent?(listener: (root: string) => void): Promise<() => void>;
  onProjectSelected?(listener: (root: string) => void): void;
  emitProjectSelected?(root: string): Promise<void>;
}

const tauriIpc: NativeIpc = {
  invoke: (command, args) => invoke(command, args),
  onIngested: (listener) => void listen('events-ingested', listener),
  onIslandPointer: (listener) => listenIslandPointer({
    listen: handler => getCurrentWebviewWindow().listen<unknown>('island-pointer', event => handler(event.payload)),
    read: () => invoke<unknown>('island_pointer'),
  }, listener),
  onProjectIntent: (listener) => listen<unknown>('project-intent', (event) => {
    if (typeof event.payload === 'string' && event.payload.length > 0) listener(event.payload);
  }),
  onProjectSelected: (listener) => { void listen<unknown>('raio-project-selected', (event) => {
    if (typeof event.payload === 'string' && event.payload.length > 0) listener(event.payload);
  }).catch(() => {}); },
  emitProjectSelected: (root) => emit('raio-project-selected', root),
  chooseFolder: async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Choose a project folder to connect' });
    return typeof picked === 'string' ? picked : null;
  },
};

/** Subscribe before sampling, so an already-inside pointer or a renderer reload cannot miss hover.
 * A newer event supersedes an older in-flight sample. No additional cursor poll is started. */
export const listenIslandPointer = async (port: {
  listen(handler: (inside: unknown) => void): Promise<() => void>;
  read(): Promise<unknown>;
}, listener: (inside: boolean) => void): Promise<() => void> => {
  let revision = 0;
  let disposed = false;
  const stop = await port.listen(value => {
    if (!disposed && typeof value === 'boolean') { revision++; listener(value); }
  });
  const sampledAt = revision;
  void port.read().then(value => {
    if (!disposed && sampledAt === revision && typeof value === 'boolean') listener(value);
  }).catch(() => {});
  return () => { disposed = true; stop(); };
};

/**
 * Pulls (and clears) the intent the core holds for the calling window, e.g. "replay". The core uses
 * the calling window, so there are no arguments. Anything but a string is treated as "no intent".
 */
export const takeSurfaceIntent = async (ipc: Pick<NativeIpc, 'invoke'> = tauriIpc): Promise<string | null> => {
  const intent = await ipc.invoke<unknown>('take_surface_intent');
  return typeof intent === 'string' ? intent : null;
};

/** The import scan and the project listing read the project, so they are repeated at most this often, and only after file activity. */
const SCAN_INTERVAL_MS = 10_000;
/** A scan that has not answered by now is given up on, so a hung call never blocks the next one. */
const SCAN_TIMEOUT_MS = 5_000;
const HOOKS_REFRESH_INTERVAL_MS = 60_000;
/** After a listing fails or times out it is tried again after each of these, even without file activity, and then left until the next activity. */
const LISTING_RETRY_DELAYS_MS: readonly number[] = [30_000, 300_000];

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
 * returns something malformed, the map has no edges and says relationships are unknown. The areas come from the
 * core's project listing (`project_inventory`, file paths and manifest names) under the same rules: until it answers,
 * or when the command is missing, fails, times out or answers something malformed, the map shows only the areas the
 * session touched (today's behaviour) and invents none. A listing that failed or timed out is retried, bounded (after
 * 30 s, then 5 min), without waiting for file activity; a relisting that fails after one worked keeps the last listing,
 * labelled as of then. Only the surfaces that draw the map (Mini Player, Expanded) ask; a project change or a timeout
 * releases the slot.
 */
export const createNativeBridge = (
  fixedSurface: Surface,
  ipc: NativeIpc = tauriIpc,
  clock: () => number = Date.now,
  scanTimeoutMs: number = SCAN_TIMEOUT_MS,
  listingRetryDelaysMs: readonly number[] = LISTING_RETRY_DELAYS_MS,
): ProjectMapBridge => {
  const report = (command: string) => (error: unknown) => console.error(`[raio] ${command} failed`, error);
  const listeners = new Set<() => void>();
  let snapshot: SessionSnapshot | null = null;
  let projectSnapshot: ProjectMapSnapshot | null = null;
  let project: ConnectedProject | null = null;
  let connectedProjects: readonly ConnectedProject[] = [];
  let selectedRoot: string | null = readSelectedRoot();
  let selectionQuery = 0;
  let startupIntent: Promise<string | null> | undefined;
  let hooksState: ProjectHooksState = 'unknown';
  let presenceInput: PresenceInput = { connected: false, available: false, facts: [] };
  let hooksQuery = 0;
  let hooksKey: string | null = null;
  let hooksTimer: ReturnType<typeof setTimeout> | undefined;
  let hooksRefreshRequested = false;
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
  // The latest accepted project listing, for the same connected project, asked for together with the import scan.
  let inventory: ProjectInventory | null = null;
  let listing = false;
  let inventoryStale = false;
  let listingFailureReported = false;
  let retryStep = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Optional read-only IPC: a missing/failed/slow command must never block showing the project. */
  const refreshHooks = (current: ConnectedProject | null, force = false): void => {
    const key = current ? `${current.id}|${current.root}` : null;
    if (key === hooksKey && !force) return;
    if (hooksTimer !== undefined) clearTimeout(hooksTimer);
    hooksTimer = undefined;
    hooksKey = key;
    const query = ++hooksQuery;
    if (!current) {
      hooksState = 'unknown';
      return;
    }
    void withinTime(ipc.invoke<unknown>('project_hooks_state', { projectId: current.id }).catch(() => null), scanTimeoutMs).then((value) => {
      if (query !== hooksQuery || project?.id !== current.id || project.root !== current.root) return;
      const next: ProjectHooksState = value === 'current' || value === 'outdated' ? value : 'unknown';
      if (next !== hooksState) {
        hooksState = next;
        presenceInput = { ...presenceInput, hooks: next };
        listeners.forEach((l) => l());
      }
      hooksTimer = setTimeout(() => {
        hooksTimer = undefined;
        refreshHooks(project, true);
      }, HOOKS_REFRESH_INTERVAL_MS);
    });
  };

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

  const listProject = async (projectId: string): Promise<ProjectInventory | null> => {
    try {
      const value = await ipc.invoke<unknown>('project_inventory', { projectId });
      return isProjectInventory(value) ? value : null;
    } catch (error) {
      if (!listingFailureReported) {
        listingFailureReported = true;
        report('project_inventory')(error);
      }
      return null;
    }
  };

  const stopRetrying = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryStep = 0;
  };

  /**
   * Asks for the project listing. A late or malformed answer changes nothing and a project change retires it. A failure
   * keeps the last good listing (labelled as of then) and schedules the next try; `fresh` is an ask caused by file activity,
   * which restarts the bounded retries.
   */
  const listIfDue = (current: ConnectedProject, fresh = true): void => {
    if (listing) return;
    if (fresh) stopRetrying();
    listing = true;
    const key = scanKey;
    void withinTime(listProject(current.id), scanTimeoutMs).then((result) => {
      if (key !== scanKey) return; // the project changed meanwhile; `listing` was already released
      listing = false;
      if (result) {
        stopRetrying();
        inventory = result;
        inventoryStale = false;
        void refresh();
        return;
      }
      if (inventory && !inventoryStale) {
        inventoryStale = true;
      }
      // A failed first listing must also notify the project-only view: pending becomes unavailable.
      void refresh();
      const delay = listingRetryDelaysMs[retryStep++];
      if (delay !== undefined) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (key === scanKey) listIfDue(current, false);
        }, delay);
      }
    });
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
    listIfDue(current);
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
        const requestedRoot = selectedRoot;
        const health = await ipc.invoke<CoreHealth | undefined>('core_status').catch(() => undefined);
        const projects = await ipc.invoke<ConnectedProject[]>('list_projects');
        connectedProjects = projects;
        // A pending list belongs to the selection it started with, not a later Connect/intent.
        if (selectedRoot !== requestedRoot) { dirty = true; return; }
        const current = (selectedRoot ? projects.find((p) => sameProjectRoot(p.root, selectedRoot!, isWindowsRoot(p.root))) : undefined) ?? projects[0] ?? null;
        const events = current ? await ipc.invoke<RaioEvent[]>('project_events', { projectId: current.id }) : [];
        if (selectedRoot !== requestedRoot) { dirty = true; return; }
        selectedRoot = current?.root ?? null;
        const key = current ? `${current.id}|${current.root}` : null;
        if (key !== scanKey) {
          scanKey = key;
          hooksState = 'unknown';
          imports = null;
          importsStale = false;
          scanActivity = -1;
          scanning = false;
          inventory = null;
          inventoryStale = false;
          listing = false;
          stopRetrying();
          scanToken++; // an answer still on its way belongs to the previous project
        }
        const projected = current ? projectSessionDetailed(current, events, undefined, imports, importsStale, inventory, inventoryStale) : null;
        project = current && project?.id === current.id && project.root === current.root ? project : current;
        const forceHooks = hooksRefreshRequested;
        hooksRefreshRequested = false;
        refreshHooks(current, forceHooks);
        presenceInput = { connected: current !== null, available: health !== undefined, facts: current ? factsFromEvents(events, current.id) : [], core: health ?? null, hooks: hooksState };
        snapshot = projected ? { ...projected.snapshot, evidence: projected.insights, ...(health ? { core: health } : {}) } : null;
        if (current) scanIfDue(current, events);
        projectSnapshot = current && !projected ? projectMap(current, inventory, imports, { pending: listing, inventoryStale, importsStale, core: health ?? null }) : null;
        listeners.forEach((l) => l());
      } catch (error) {
        report('refresh')(error);
        const hooksChanged = hooksState !== 'unknown';
        hooksState = 'unknown';
        presenceInput = { ...presenceInput, available: false, hooks: 'unknown' };
        if (projectSnapshot) {
          projectSnapshot = { ...projectSnapshot, core: null };
        }
        if (projectSnapshot || hooksChanged || project) {
          listeners.forEach((l) => l());
        }
      } finally {
        refreshing = null;
        if (dirty) {
          dirty = false;
          await refresh();
        }
      }
    })();
    return refreshing;
  };
  ipc.onIngested(() => void refresh());
  void refresh();

  const selectProject = async (root: string, broadcast = true): Promise<boolean> => {
    const query = ++selectionQuery;
    await refresh();
    if (query !== selectionQuery) return false;
    const match = connectedProjects.find((p) => sameProjectRoot(p.root, root, isWindowsRoot(p.root)));
    if (!match) return false;
    selectedRoot = match.root;
    saveSelectedRoot(match.root);
    await refresh();
    if (query !== selectionQuery) return false;
    // Renderer-to-renderer selection keeps Island/Mini on the same project; never writes settings.
    if (broadcast) await ipc.emitProjectSelected?.(match.root).catch(report('project selection'));
    return true;
  };
  ipc.onProjectSelected?.((root) => {
    if (project && sameProjectRoot(project.root, root, isWindowsRoot(project.root))) return;
    void selectProject(root, false);
  });

  const connector: Connector = {
    project: () => project,
    chooseFolder: () => ipc.chooseFolder(),
    preview: (root) => ipc.invoke<ConnectPreview>('preview_connect', { root }),
    connect: async (root, previewed) => {
      const connected = await ipc.invoke<ConnectedProject>('connect_project', { root, previewed });
      if (!connected || typeof connected.id !== 'string' || typeof connected.name !== 'string' || typeof connected.root !== 'string' || !connected.root) throw new Error('Core did not return the connected project');
      selectedRoot = connected.root;
      saveSelectedRoot(connected.root);
      hooksRefreshRequested = true;
      await refresh();
      await ipc.emitProjectSelected?.(connected.root).catch(report('project selection'));
    },
    disconnect: async () => {
      if (!project) return;
      await ipc.invoke('disconnect_project', { projectId: project.id });
      hooksRefreshRequested = true;
      await refresh();
    },
  };

  return {
    kind: 'native',
    fixedSurface,
    currentSession: () => snapshot,
    takeProjectIntent: () => {
      // Cache the once-delivered read so a StrictMode effect cleanup cannot consume and lose it.
      startupIntent ??= withinTime(ipc.invoke<unknown>('take_project_intent').catch(() => null), scanTimeoutMs)
        .then((value) => typeof value === 'string' && value.length > 0 ? value : null);
      return startupIntent;
    },
    onProjectIntent: (listener) => ipc.onProjectIntent?.(listener) ?? Promise.resolve(() => {}),
    selectProject: (root) => selectProject(root),
    previewProjectMap: async (root) => {
      const value = await withinTime(ipc.invoke<unknown>('preview_project_map', { root }).catch(() => null), scanTimeoutMs);
      if (!value || typeof value !== 'object' || !('inventory' in value) || !('imports' in value) || !isProjectInventory(value.inventory) || !isProjectImports(value.imports)) return null;
      const name = root.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1) || root;
      return projectMap({ id: 'preview', name }, value.inventory, value.imports);
    },
    projectHooksState: () => hooksState,
    projectPresence: () => presenceInput,
    currentProjectMap: () => projectSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showSurface: (surface, intent) => void ipc.invoke('show_surface', { surface, intent: intent ?? null }).catch(report('show_surface')),
    setPinned: (pinned) => void ipc.invoke('set_always_on_top', { surface: 'mini', onTop: pinned }).catch(report('set_always_on_top')),
    setIslandHitRect: (rect) => void ipc.invoke('set_island_hit_rect', { rect }).catch(report('set_island_hit_rect')),
    onIslandPointer: (listener) => ipc.onIslandPointer?.(listener) ?? Promise.resolve(() => {}),
    projectImports: () => Promise.resolve(imports),
    projectInventory: () => Promise.resolve(inventory),
    connector,
  };
};
