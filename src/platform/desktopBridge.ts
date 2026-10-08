import type { ArchitectureGraph } from '../features/architecture/model/types';
import type { ProjectImports } from '../features/project/importEdges';
import type { ProjectInventory } from '../features/project/projectInventory';
import type { ProjectInsights } from '../features/project/projectInsights';
import type { SessionLog } from '../features/session/model/events';
import type { ProjectMapSnapshot } from '../features/project/projectMap';
import type { PresenceInput } from '../features/modes/companionPresence';
import type { ClaudeUsageState } from '../features/usage/claudeUsage';

/** Where the data on screen comes from. Fixture data must never be presented as real agent telemetry. */
export type DataProvenance = 'fixture' | 'live';

/** The three product surfaces. */
export type Surface = 'island' | 'mini' | 'expanded';
export type SurfaceIntent = 'replay';
export type ProjectHooksState = 'current' | 'outdated' | 'unknown';

export interface SessionSnapshot {
  readonly provenance: DataProvenance;
  readonly project: string;
  readonly graph: ArchitectureGraph;
  readonly log: SessionLog;
  /** Evidence the replay log cannot carry (disk consistency, unassigned changes, stale checks). Live data only. */
  readonly evidence?: ProjectInsights;
  /** Health of the local pipeline, so missing data is never mistaken for "nothing happened". */
  readonly core?: CoreHealth;
  /**
   * Dev/test only: this fixture session is delivered as a simulated live feed (events appended over time).
   * `arrivalMs[i]` is when `log.events[i]` arrived on the feed's clock. Never set on real telemetry.
   */
  readonly simulatedFeed?: { readonly arrivalMs: readonly number[] };
}

export interface CoreHealth {
  readonly dropped: number;
  /** True when dropped is only a lower bound; absent means an exact count (older cores). */
  readonly droppedAtLeast?: boolean;
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
  /** Optional alpha commands: older cores/adapters can report unavailable without fabricating data. */
  takeProjectIntent?(): Promise<string | null>;
  onProjectIntent?(listener: (root: string) => void): Promise<() => void>;
  /** Selects an already connected project, never writes integration settings. */
  selectProject?(root: string): Promise<boolean>;
  previewProjectMap?(root: string): Promise<ProjectMapSnapshot | null>;
  /** Cached read-only state of the connected project's Raio handlers; absent on older adapters. */
  projectHooksState?(): ProjectHooksState;
  /** Project-wide recorded facts, including failed edits and earlier-session history. */
  projectPresence?(): PresenceInput;
  /** Latest Claude plan usage reading (see features/usage/claudeUsage.ts); absent on adapters without the reader. */
  claudeUsage?(): ClaudeUsageState;
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
  /** Core cursor truth; native Island ignores DOM hover while its window is click-through. */
  onIslandPointer(listener: (inside: boolean) => void): Promise<() => void>;
  /**
   * The latest static import facts of the connected project (paths and specifiers only) that this bridge holds, or
   * null when there is none: no project, no scan yet, or the scan failed, timed out or was malformed. It never
   * starts a scan; the map has edges only from a scan the bridge itself accepted.
   */
  projectImports(): Promise<ProjectImports | null>;
  /**
   * The latest project inventory (file paths and manifest names only) that this bridge holds, or null when there is none:
   * no project, no listing yet, or the listing failed, timed out or was malformed (the map then shows only the areas a
   * session touched). It never starts a listing.
   */
  projectInventory(): Promise<ProjectInventory | null>;
  /** Project connection; null where it is not available (browser, fixtures). */
  readonly connector: Connector | null;
}
