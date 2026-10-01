import type { ArchitectureGraph } from '../../architecture/model/types';
import { compileReplay } from '../model/compileReplay';
import type { SessionLog } from '../model/events';
import type { ChoreographyScript } from '../model/script';
import { type LiveContext, type LiveState, retargetLive, startLive, stepLive } from './liveDirector';

/** One projection of the session arriving at the director (wall milliseconds on the feed's own clock). */
export interface FeedStep {
  readonly wallMs: number;
  readonly script: ChoreographyScript;
}

/**
 * The scripts a feed produces: one per distinct arrival time, each compiled from the events that had
 * arrived by then. `arrivalMs[i]` is when `log.events[i]` reached Raio.
 */
export const feedSteps = (log: SessionLog, arrivalMs: readonly number[], graph: ArchitectureGraph): FeedStep[] => {
  const times = [...new Set(arrivalMs.slice(0, log.events.length))].sort((a, b) => a - b);
  return times.map((wallMs) => ({
    wallMs,
    script: compileReplay({ ...log, events: log.events.filter((_, i) => (arrivalMs[i] ?? Infinity) <= wallMs) }, graph, { live: true }),
  }));
};

const FRAME_MS = 1000 / 60;

/**
 * Runs the director over a feed on a fixed 60 fps clock and returns its state at `untilMs`.
 * Deterministic: the same steps and time always give the same playhead (visual tests, unit tests).
 */
export const simulateLive = (steps: readonly FeedStep[], untilMs: number, ctx: LiveContext = { visible: true, reducedMotion: false }): LiveState => {
  let state: LiveState | null = null;
  let next = 0;
  const advanceTo = (ms: number): void => {
    while (next < steps.length && steps[next]!.wallMs <= ms + 1e-6) {
      const step = steps[next++]!;
      state = state ? retargetLive(state, step.script, step.wallMs) : startLive(step.script, step.wallMs);
    }
    if (state) state = stepLive(state, ms, ctx);
  };
  for (let ms = 0; ms < untilMs; ms += FRAME_MS) advanceTo(ms);
  advanceTo(untilMs);
  if (!state) throw new Error('The feed has nothing before the requested time');
  return state;
};
