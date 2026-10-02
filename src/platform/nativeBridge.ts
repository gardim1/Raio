import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { RaioEvent } from '../features/ingest/raioEvent';
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

/**
 * Bridge to the Tauri core: reads the persisted events of the connected project and projects the
 * latest session (provenance 'live'). With no connected project or no agent events it reports null,
 * so the surfaces show the empty state instead of demo data.
 */
export const createNativeBridge = (fixedSurface: Surface, ipc: NativeIpc = tauriIpc): DesktopBridge => {
  const report = (command: string) => (error: unknown) => console.error(`[raio] ${command} failed`, error);
  const listeners = new Set<() => void>();
  let snapshot: SessionSnapshot | null = null;
  let project: ConnectedProject | null = null;
  let refreshing: Promise<void> | null = null;
  let dirty = false;

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
        const projected = current ? projectSessionDetailed(current, events) : null;
        project = current && project?.id === current.id && project.root === current.root ? project : current;
        snapshot = projected ? { ...projected.snapshot, evidence: projected.insights, ...(health ? { core: health } : {}) } : null;
        listeners.forEach((l) => l());
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
    connector,
  };
};
