import { demoGraph } from '../features/architecture/model/demoProject';
import { createGraph } from '../features/architecture/model/graph';
import type { SessionLog } from '../features/session/model/events';
import { demoSessionLog } from '../features/session/model/demoSession';
import { useSessionUi } from '../features/session/store/sessionStore';
import type { DesktopBridge, SessionSnapshot } from './desktopBridge';

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
  return {
    kind: 'fixture',
    fixedSurface: null,
    currentSession: () => snapshot,
    subscribe: () => () => {},
    showSurface: showSurfaceInPlace,
    setPinned: () => {},
    setIslandHitRect: () => {},
    connector: null,
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

/** The map the live product has today: the demo's systems, no relationships (never invented). */
const feedGraph = createGraph(demoGraph.nodes, []);

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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    showSurface: showSurfaceInPlace,
    setPinned: () => {},
    setIslandHitRect: () => {},
    connector: null,
  };
};
