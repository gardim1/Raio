import type { ArchitectureGraph } from '../features/architecture/model/types';
import type { ProjectInsights } from '../features/project/projectInsights';
import type { SessionLog } from '../features/session/model/events';

/** Where the data on screen comes from. Fixture data must never be presented as real agent telemetry. */
export type DataProvenance = 'fixture' | 'live';

/** The three product surfaces. */
export type Surface = 'island' | 'mini' | 'expanded';
export type SurfaceIntent = 'replay';

export interface SessionSnapshot {
  readonly provenance: DataProvenance;
  readonly project: string;
  readonly graph: ArchitectureGraph;
  readonly log: SessionLog;
  /** Evidence the replay log cannot carry (disk consistency, unassigned changes, stale checks). Live data only. */
  readonly evidence?: ProjectInsights;
  /** Health of the local pipeline, so missing data is never mistaken for "nothing happened". */
  readonly core?: CoreHealth;
}

export interface CoreHealth {
  readonly dropped: number;
  readonly watcherOverflow: boolean;
  readonly historyResetFrom: string | null;
  readonly hookBinary: string | null;
}

/** Exactly what connecting would write to the project's `.claude/settings.local.json`. */
export interface ConnectPreview {
  readonly settingsPath: string;
  readonly before: string | null;
  readonly after: string;
  /** false: git would not ignore the file, so it could be committed with a personal path. null: unknown. */
  readonly gitIgnored: boolean | null;
}

export interface ConnectedProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

/** Opt-in, reversible connection of one project to an agent's hooks (native only). */
export interface Connector {
  /** The connected project, or null. Stable between notifications of `subscribe`. */
  project(): ConnectedProject | null;
  chooseFolder(): Promise<string | null>;
  preview(root: string): Promise<ConnectPreview>;
  connect(root: string, preview: ConnectPreview): Promise<void>;
  disconnect(): Promise<void>;
}

/** A rectangle in CSS pixels of the current window. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The renderer's only door to the desktop core. Implemented by a fixture adapter
 * (browser, tests, dev harness) and by the native shell adapter.
 */
export interface DesktopBridge {
  readonly kind: 'fixture' | 'native';
  /** The surface this window is dedicated to (native), or null when one view switches in place (browser). */
  readonly fixedSurface: Surface | null;
  /** The session to show, or null when no project/session is available. */
  currentSession(): SessionSnapshot | null;
  /** Notifies when `currentSession()` may return something new. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Moves the user to another surface: switches in place (browser) or shows that window (native).
   * `intent: 'replay'` asks the target surface to start the session replay.
   */
  showSurface(surface: Surface, intent?: SurfaceIntent): void;
  /** Mini Player "keep on top" toggle. No-op where windows do not exist. */
  setPinned(pinned: boolean): void;
  /** Island click-through: the capsule area that should receive the pointer. No-op in the browser. */
  setIslandHitRect(rect: Rect): void;
  /** Project connection; null where it is not available (browser, fixtures). */
  readonly connector: Connector | null;
}
