import { clamp } from '../../../shared/motion/easing';
import { CTA_PROMINENT_SECONDS } from '../../modes/presence';
import type { ChoreographyScript, LiveMarks } from '../model/script';

/**
 * The live director decides *when* the shared choreography plays while a session is under way.
 * It does not draw or model anything: the script comes from `compileReplay(log, graph, { live: true })`
 * and is drawn by `evaluateFrame`, exactly like the replay. Pure functions of (state, wall time);
 * the React hook only feeds them the clock.
 *
 * Pacing rules (all in script seconds unless noted):
 *  1. New activity plays in order at natural speed (rate 1).
 *  2. When events arrive faster than they can play, the playhead catches up at
 *     `rate = clamp(lag / LAG_TARGET_SECONDS, 1, RATE_MAX)`, fixed when the content arrives, so the
 *     time left to reach the latest event is at most LAG_TARGET_SECONDS (real seconds) and shrinks.
 *  3. If even RATE_MAX is not enough (lag > RATE_MAX × LAG_TARGET_SECONDS), the surplus at the front is
 *     skipped, landing on a motion boundary, so what remains plays within LAG_TARGET_SECONDS at RATE_MAX.
 *  4. A skip never passes a notice, a failed/stale/unknown/incomplete check, or the arrival of the stop that
 *     raised it (see `protectedTimes`). When such a moment blocks the skip the delay may exceed the target;
 *     the moment is played, at no more than RATE_MAX. Catch-up is re-run every step while the remaining
 *     time exceeds the target, so the view is back within it right after the protected moment has played.
 *     Protected moments that follow one another with no unprotected gap big enough to land in (back-to-back
 *     notices or failed checks) are the only exception to the <= 2 s bound: the view then stays behind until
 *     the last of them has played, at no more than RATE_MAX.
 *  5. Hidden: nothing advances. Shown again, or in reduced motion: jump to the settled latest state
 *     (`settledAt`), never a backlog replay.
 *  6. Session end: the tail (return, summary) plays at natural speed from the last stop, then the view
 *     settles in the end-state view and the clock stops.
 *  7. Idle: an open session is parked on a floating hover with a few scheduled blinks (`live.quietAt`). Once
 *     the playhead passes the last one it stops (`isSettled`), and so does the frame loop (`runLiveLoop`);
 *     nothing runs while the session sits idle. A new event moves the playhead back to the parked stop.
 */
export const LAG_TARGET_SECONDS = 2;
export const RATE_MAX = 3;
/** A skip lands this long before a protected moment, so its whole animation plays. */
export const NOTICE_LEAD_SECONDS = 0.1;
/** Past the latest arrival, long enough for the node activation, detail line and notice pill to finish. */
export const JUMP_MARGIN_SECONDS = 1;
/** Longest wall-clock step the playhead integrates (a stalled frame must not leap). */
const MAX_STEP_SECONDS = 0.25;
/** The end-state view is held this long past the completion offer, like the live demo. */
const END_VIEW_EXTRA_SECONDS = 2;

export interface LiveState {
  readonly script: ChoreographyScript;
  /** The playhead: script seconds shown now. */
  readonly t: number;
  /** Playback rate fixed when the current content arrived (1 = natural speed). */
  readonly rate: number;
  /** Wall clock (ms) of the last update. */
  readonly wallMs: number;
  /** Frames were suppressed (hidden) after the playhead was last updated: the next visible step jumps. */
  readonly stale: boolean;
}

export interface LiveContext {
  readonly visible: boolean;
  readonly reducedMotion: boolean;
}

const marksOf = (script: ChoreographyScript): LiveMarks => {
  if (!script.live) throw new Error('The live director needs a script compiled with { live: true }');
  return script.live;
};

/** The moments a skip must never jump over: notices and checks that are not a plain pass. */
export const protectedTimes = (script: ChoreographyScript): number[] => [
  ...script.risks.map((r) => r.at),
  ...script.validations.filter((v) => v.status !== 'passed' && v.status !== 'running').map((v) => v.at),
];

/** How long a protected moment keeps playing after it starts: a notice's ripples and pill, a check's pill. */
export const NOTICE_PLAY_SECONDS = 2.1;
export const CHECK_PLAY_SECONDS = 0.7;

/** Protected moments with their whole animation: no skip may start inside one or land after its start. */
const protectedWindows = (script: ChoreographyScript): { from: number; to: number }[] => [
  ...script.risks.map((r) => ({ from: r.at - NOTICE_LEAD_SECONDS, to: r.at + NOTICE_PLAY_SECONDS })),
  ...script.validations
    .filter((v) => v.status !== 'passed' && v.status !== 'running')
    .map((v) => ({ from: v.at - NOTICE_LEAD_SECONDS, to: v.at + CHECK_PLAY_SECONDS })),
];

/** Where the view rests: the latest stop fully drawn (open session) or the end-state view (ended). */
export const settledAt = (script: ChoreographyScript): number => {
  const live = marksOf(script);
  return live.open ? live.eventsEndAt + JUMP_MARGIN_SECONDS : script.summary.detailAt + CTA_PROMINENT_SECONDS + END_VIEW_EXTRA_SECONDS;
};

/** True when nothing will change until the script does: the end-state view, the parked view after its last cue, or the stepped (reduced-motion) view. */
export const isSettled = (state: LiveState, reducedMotion: boolean): boolean => {
  const live = marksOf(state.script);
  if (reducedMotion) return state.t >= settledAt(state.script) - 1e-9;
  return live.open ? state.t >= live.quietAt - 1e-9 : state.t >= settledAt(state.script) - 1e-9;
};

/** Motion boundaries (segment starts): the only places a skip may land, so the orb is never cut mid-motion. */
const boundaries = (script: ChoreographyScript): number[] => script.orb.map((s) => s.t0);

/** Applies rules 2–4 to a playhead: returns where to continue from and at which rate. */
const catchUp = (script: ChoreographyScript, from: number): { t: number; rate: number } => {
  const horizon = marksOf(script).eventsEndAt;
  let t = from;
  const maxLag = RATE_MAX * LAG_TARGET_SECONDS;
  const windows = protectedWindows(script);
  // Inside a protected moment nothing is skipped: it plays out in full.
  if (horizon - t > maxLag && !windows.some((w) => t > w.from && t < w.to)) {
    const blocker = Math.min(...windows.filter((w) => w.from >= t).map((w) => w.from));
    const limit = Math.min(horizon, blocker);
    const want = horizon - maxLag;
    const reachable = boundaries(script).filter((b) => b > t && b <= limit);
    const enough = reachable.filter((b) => b >= want);
    const landing = enough.length > 0 ? Math.min(...enough) : reachable.length > 0 ? Math.max(...reachable) : null;
    if (landing !== null) t = landing;
  }
  const lag = Math.max(0, horizon - t);
  return { t, rate: clamp(lag / LAG_TARGET_SECONDS, 1, RATE_MAX) };
};

/** Maps the playhead into a recompiled script. The prefix of an appended log is identical, so most cases are the identity. */
const remap = (from: ChoreographyScript, to: ChoreographyScript, t: number): number => {
  const before = from.live;
  const after = to.live;
  if (!before || !after) return t;
  let index = -1;
  before.visits.forEach((v, i) => {
    if (t >= v.arrivalAt) index = i;
  });
  if (index < 0) return t;
  const was = before.visits[index]!;
  const now = after.visits[index];
  if (!now || now.nodeId !== was.nodeId) return Math.min(t, after.eventsEndAt);
  const idle = index === before.visits.length - 1 && t >= was.readyAt;
  if (!idle) return t;
  // Parked at the latest stop and something new arrived: the new content starts from where the orb is parked.
  if (after.visits.length > before.visits.length) return now.readyAt;
  // The session ended: the tail plays from the last stop.
  if (before.open && !after.open) return now.readyAt;
  // More notices at the stop Raio is parked at: play them (not for the first stop, whose arrival is the orbit).
  if (index > 0 && now.notices > was.notices) return Math.min(t, now.arrivalAt);
  return t;
};

/**
 * First time a session is seen. A session that has only just started plays from the beginning so the
 * viewer sees Raio wake; anything further along (or already ended) is shown as it stands now.
 */
export const startLive = (script: ChoreographyScript, wallMs: number): LiveState => {
  const live = marksOf(script);
  const fresh = live.open && live.visits.length === 0;
  const t = fresh ? 0 : settledAt(script);
  return { script, ...catchUp(script, t), wallMs, stale: false };
};

/** A newly projected script arrives (an event was appended). Visible: queue/compress. Hidden: only keep the playhead valid. */
export const retargetLive = (state: LiveState, script: ChoreographyScript, wallMs: number): LiveState => {
  if (state.script === script) return state;
  // Another session: it is seen for the first time, whatever the old playhead was.
  if (state.script.id !== script.id) return { ...startLive(script, wallMs), stale: state.stale };
  const t = remap(state.script, script, state.t);
  if (state.stale) return { ...state, script, t: Math.min(t, marksOf(script).eventsEndAt), rate: 1, wallMs };
  return { ...state, script, ...catchUp(script, t), wallMs };
};

/** Advances the playhead to `wallMs`. */
export const stepLive = (state: LiveState, wallMs: number, ctx: LiveContext): LiveState => {
  if (!ctx.visible) return state.stale && state.wallMs === wallMs ? state : { ...state, wallMs, stale: true };
  const { script } = state;
  const live = marksOf(script);
  const target = settledAt(script);
  if (ctx.reducedMotion || state.stale) return { ...state, t: Math.max(state.t, target), rate: 1, wallMs, stale: false };

  const dt = clamp((wallMs - state.wallMs) / 1000, 0, MAX_STEP_SECONDS);
  let t = state.t + dt * state.rate;
  if (state.t < live.eventsEndAt && t >= live.eventsEndAt) {
    // Crossed into idle/tail time within this step: the remainder plays at natural speed.
    const toHorizon = (live.eventsEndAt - state.t) / state.rate;
    t = live.eventsEndAt + (dt - toHorizon);
  }
  // The end-state view and the parked view after its last scheduled cue hold still.
  t = Math.min(t, live.open ? live.quietAt : target);
  let rate = t >= live.eventsEndAt ? 1 : state.rate;
  if (t < live.eventsEndAt && (live.eventsEndAt - t) / rate > LAG_TARGET_SECONDS + 1e-9) {
    // Still further behind than the target (a protected moment blocked the catch-up): try again from here.
    const again = catchUp(script, t);
    t = again.t;
    rate = again.rate;
  }
  return { ...state, t, rate, wallMs };
};
