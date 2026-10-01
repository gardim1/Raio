import { isSettled, type LiveContext, type LiveState, stepLive } from './liveDirector';

export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

export interface LiveLoopOptions {
  readonly read: () => LiveState;
  readonly write: (state: LiveState) => void;
  readonly ctx: LiveContext;
  readonly schedule: FrameScheduler;
  /** Draws the current state. */
  readonly paint: () => void;
  /** While parked only a slow float and the odd blink are on screen; paint at most this often (ms). */
  readonly idleFrameMs?: number;
}

const IDLE_FRAME_MS = 33;

/**
 * Drives the live director with animation frames. It schedules the next frame only while something can
 * still change: the loop ends once the view is settled (end-state view, parked view after its last
 * scheduled blink, or the stepped reduced-motion view), so an idle open session costs no JS at all.
 * Returns a function that cancels the pending frame.
 */
export const runLiveLoop = ({ read, write, ctx, schedule, paint, idleFrameMs = IDLE_FRAME_MS }: LiveLoopOptions): (() => void) => {
  let handle = 0;
  let lastPaint = -Infinity;
  const tick = (now: number): void => {
    const next = stepLive(read(), now, ctx);
    write(next);
    const settled = isSettled(next, ctx.reducedMotion);
    const parked = next.t >= (next.script.live?.eventsEndAt ?? 0);
    if (settled || !parked || now - lastPaint >= idleFrameMs) {
      lastPaint = now;
      paint();
    }
    if (!settled) handle = schedule.request(tick);
  };
  handle = schedule.request(tick);
  return () => schedule.cancel(handle);
};
