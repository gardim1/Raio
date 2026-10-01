import type { ArchitectureGraph } from '../features/architecture/model/types';
import type { SessionLog } from '../features/session/model/events';

/** Where the data on screen comes from. Fixture data must never be presented as real agent telemetry. */
export type DataProvenance = 'fixture' | 'live';

export interface SessionSnapshot {
  readonly provenance: DataProvenance;
  readonly project: string;
  readonly graph: ArchitectureGraph;
  readonly log: SessionLog;
}

/**
 * The renderer's only door to the desktop core. Implemented by a fixture adapter
 * (browser, tests, dev harness) and by the native shell adapter.
 */
export interface DesktopBridge {
  readonly kind: 'fixture' | 'native';
  /** The session to show, or null when no project/session is available. */
  currentSession(): SessionSnapshot | null;
  /** Notifies when `currentSession()` may return something new. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
