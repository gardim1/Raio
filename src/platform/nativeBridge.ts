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
import type { ClaudeUsageState, ClaudeUsageSnapshot } from '../features/usage/claudeUsage';
import type { ConnectedProject, ConnectPreview, Connector, CoreHealth, IntegrationStatus, ProjectHooksState, SessionSnapshot, Surface } from './desktopBridge';

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
  onUsageChanged?(listener: () => void): void;
  onIslandPointer?(listener: (inside: boolean) => void): Promise<() => void>;
  chooseFolder(): Promise<string | null>;
  onProjectIntent?(listener: (root: string) => void): Promise<() => void>;
  onProjectSelected?(listener: (root: string) => void): void;
  emitProjectSelected?(root: string): Promise<void>;
}

const tauriIpc: NativeIpc = {
  invoke: (command, args) => invoke(command, args),
  onIngested: (listener) => void listen('events-ingested', listener),
  onUsageChanged: (listener) => { void listen('claude-usage-changed', listener).catch(() => {}); },
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
const integrationStatusFrom = (value: unknown): IntegrationStatus | null => {
  if (!value || typeof value !== 'object') return null;
  const status = value as Partial<IntegrationStatus>;
  if (!['current', 'outdated', 'missing', 'unknown'].includes(status.hooks ?? '')
    || typeof status.hookBinary !== 'boolean'
    || (status.heartbeatAgeMs !== null && (typeof status.heartbeatAgeMs !== 'number' || !Number.isFinite(status.heartbeatAgeMs) || status.heartbeatAgeMs < 0))
    || (status.inertMarkerAt !== null && (typeof status.inertMarkerAt !== 'number' || !Number.isFinite(status.inertMarkerAt)))
    || (status.lastHookEventAt !== null && (typeof status.lastHookEventAt !== 'number' || !Number.isFinite(status.lastHookEventAt)))
    || (status.lastHookSessionId !== null && typeof status.lastHookSessionId !== 'string')
    || (status.lastWatcherChangeAt !== null && (typeof status.lastWatcherChangeAt !== 'number' || !Number.isFinite(status.lastWatcherChangeAt)))) return null;
  return {
    hooks: status.hooks as IntegrationStatus['hooks'], hookBinary: status.hookBinary,
    heartbeatAgeMs: status.heartbeatAgeMs ?? null, inertMarkerAt: status.inertMarkerAt ?? null,
    lastHookEventAt: status.lastHookEventAt ?? null, lastHookSessionId: status.lastHookSessionId ?? null,
    lastWatcherChangeAt: status.lastWatcherChangeAt ?? null,
  };
};

const sameIntegrationStatus = (a: IntegrationStatus | undefined, b: IntegrationStatus | undefined): boolean =>
  a === b || (!!a && !!b &&
  a.hooks === b.hooks && a.hookBinary === b.hookBinary && a.heartbeatAgeMs === b.heartbeatAgeMs
  && a.inertMarkerAt === b.inertMarkerAt && a.lastHookEventAt === b.lastHookEventAt
  && a.lastHookSessionId === b.lastHookSessionId && a.lastWatcherChangeAt === b.lastWatcherChangeAt);

/** Reject malformed IPC rather than drawing fabricated zeroes or another project's reading. */
const usageState = (value: unknown, projectId: string): ClaudeUsageState => {
  const error: ClaudeUsageState = { status: 'error', reason: 'Claude plan usage is unavailable.' };
  if (!value || typeof value !== 'object' || !('status' in value)) return error;
  if (value.status === 'disabled' || value.status === 'waiting') return { status: value.status };
  if ((value.status === 'error' || value.status === 'incompatible') && 'reason' in value && typeof value.reason === 'string' && value.reason.length <= 500) return { status: value.status, reason: value.reason };
  if (value.status !== 'reading' || !('latest' in value) || !('sourceCount' in value) || !Number.isInteger(value.sourceCount) || typeof value.sourceCount !== 'number' || value.sourceCount < 0 || value.sourceCount > 32) return error;
  const latest = value.latest as ClaudeUsageSnapshot | null;
  if (!latest || !latest.source || latest.source.kind !== 'claude-statusline' || latest.source.projectId !== projectId
    || typeof latest.source.sessionId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(latest.source.sessionId)
    || !Number.isFinite(latest.receivedAtMs) || latest.receivedAtMs < 1_577_836_800_000 || latest.receivedAtMs > 4_102_444_800_000
    || (latest.source.claudeVersion !== undefined && (typeof latest.source.claudeVersion !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(latest.source.claudeVersion)))) return error;
  for (const reading of [latest.fiveHour, latest.sevenDay]) {
    if (reading === undefined) continue;
    if (!reading || !Number.isFinite(reading.usedPercentage) || reading.usedPercentage < 0 || reading.usedPercentage > 100
      || (reading.resetsAtMs !== null && (!Number.isFinite(reading.resetsAtMs) || reading.resetsAtMs < 1_577_836_800_000 || reading.resetsAtMs > 4_102_444_800_000))) return error;
  }
  return { status: 'reading', latest, sourceCount: value.sourceCount };
};
/** After a listing fails or times out it is tried again after each of these, even without file activity, and then left until the next activity. */
const LISTING_RETRY_DELAYS_MS: readonly number[] = [30_000, 300_000];

/** IPC messages are display data, not stacks/objects. Redact paths before bounding or logging them.
 * Spaces and punctuation are valid in filenames: retain a quoted path's closing quote, otherwise
 * conservatively redact through the next message colon (followed by whitespace), newline or end. */
const listingFailureReason = (error: unknown): string | undefined => {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const starts = /file:\/\/\/?(?:[a-z]:)?|[a-z]:[\\/]|\\\\|(?<![\p{L}\p{N}_/\\])[\\/]/giu;
  let redacted = '', cursor = 0;
  for (const match of text.matchAll(starts)) {
    const start = match.index;
    if (start < cursor) continue;
    const bodyStart = start + match[0].length;
    const delimiter = text.slice(bodyStart).search(/:(?=\s|$)|[\r\n]/);
    let end = delimiter < 0 ? text.length : bodyStart + delimiter;
    const quote = text[start - 1];
    if (quote === '"' || quote === "'") {
      for (let at = bodyStart; at < text.length; at++) {
        // Apostrophes, commas and spaces may be filename characters (O' Connor).
        // Treat a quote as a boundary only before the message colon or the end.
        if (text[at] === quote && /^\s*(?::(?:\s|$)|$)/.test(text.slice(at + 1))) { end = at; break; }
      }
    }
    redacted += text.slice(cursor, start) + '[folder]';
    cursor = end;
  }
  const reason = (redacted + text.slice(cursor)).trim();
  return !reason ? undefined : reason.length <= 240 ? reason : `${reason.slice(0, 239).trimEnd()}…`;
};

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
  let integration: IntegrationStatus | undefined;
  let usage: ClaudeUsageState = { status: 'disabled' };
  let usageKey: string | null = null;
  let usageQuery = 0;
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
  let listingToken = 0;
  let inventoryStale = false;
  let unavailableReason: string | undefined;
  let listingFailureReported = false;
  let retryStep = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshUsage = (current: ConnectedProject | null, force = false): void => {
    const key = current ? `${current.id}|${current.root}` : null;
    if (!force && key === usageKey) return;
    const projectChanged = key !== usageKey;
    usageKey = key;
    const query = ++usageQuery;
    if (!current) { usage = { status: 'disabled' }; return; }
    if (projectChanged) usage = { status: 'waiting' };
    void withinTime(ipc.invoke<unknown>('claude_usage', { projectId: current.id }).catch(() => null), scanTimeoutMs).then(value => {
      if (query !== usageQuery || project?.id !== current.id || project.root !== current.root) return;
      usage = usageState(value, current.id);
      listeners.forEach(l => l());
    });
  };

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

  const listProject = async (projectId: string): Promise<{ inventory: ProjectInventory | null; reason?: string }> => {
    try {
      const value = await ipc.invoke<unknown>('project_inventory', { projectId });
      return { inventory: isProjectInventory(value) ? value : null };
    } catch (error) {
      const reason = listingFailureReason(error);
      if (!listingFailureReported) {
        listingFailureReported = true;
        report('project_inventory')(reason ?? 'Project listing unavailable');
      }
      return { inventory: null, reason };
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
    const token = ++listingToken;
    void withinTime(listProject(current.id), scanTimeoutMs).then((result) => {
      if (key !== scanKey || token !== listingToken) return; // also retires A's old request after A → B → A
      listing = false;
      unavailableReason = result?.reason;
      if (result?.inventory) {
        stopRetrying();
        inventory = result.inventory;
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
          integration = undefined;
          imports = null;
          importsStale = false;
          scanActivity = -1;
          scanning = false;
          inventory = null;
          inventoryStale = false;
          unavailableReason = undefined;
          listing = false;
          listingToken++;
          stopRetrying();
          scanToken++; // an answer still on its way belongs to the previous project
        }
        const integrationValue = current
          ? await ipc.invoke<unknown>('integration_status', { projectId: current.id }).catch(() => null)
          : null;
        if (selectedRoot !== requestedRoot) { dirty = true; return; }
        const nextIntegration = integrationStatusFrom(integrationValue) ?? undefined;
        if (!sameIntegrationStatus(integration, nextIntegration)) integration = nextIntegration;
        const projected = current ? projectSessionDetailed(current, events, undefined, imports, importsStale, inventory, inventoryStale) : null;
        project = current && project?.id === current.id && project.root === current.root ? project : current;
        const forceHooks = hooksRefreshRequested;
        hooksRefreshRequested = false;
        refreshHooks(current, forceHooks);
        refreshUsage(current, forceHooks);
        presenceInput = { connected: current !== null, available: health !== undefined, facts: current ? factsFromEvents(events, current.id) : [], core: health ?? null, hooks: hooksState };
        snapshot = projected ? { ...projected.snapshot, evidence: projected.insights, ...(health ? { core: health } : {}) } : null;
        if (current) scanIfDue(current, events);
        projectSnapshot = current && !projected ? projectMap(current, inventory, imports, { pending: listing, inventoryStale, importsStale, core: health ?? null, unavailableReason }) : null;
        listeners.forEach((l) => l());
      } catch (error) {
        report('refresh')(error);
        const hooksChanged = hooksState !== 'unknown';
        hooksState = 'unknown';
        integration = undefined;
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
  // Snapshot, configuration and clear invalidations all bypass the same-project cache in every webview.
  ipc.onUsageChanged?.(() => refreshUsage(project, true));
  void refresh();

  const selectProject = async (root: string, broadcast = true): Promise<boolean> => {
    const query = ++selectionQuery;
    // Cached explicit selections take effect before waiting on a possibly slow event/listing refresh.
    // That makes an older A/B answer fail refresh's requested-root check instead of flashing over the latest choice.
    const cached = connectedProjects.find((p) => sameProjectRoot(p.root, root, isWindowsRoot(p.root)));
    if (cached) {
      selectedRoot = cached.root;
      saveSelectedRoot(cached.root);
    }
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
    preview: (root, usage) => ipc.invoke<ConnectPreview>('preview_connect', { root, ...(usage ? { usage } : {}) }),
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
    integrationStatus: () => integration,
    projectPresence: () => presenceInput,
    claudeUsage: () => usage,
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
