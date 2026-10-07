import { useEffect, useMemo, useRef, useState } from 'react';
import { frozenClock } from '../../../shared/motion/frozenClock';
import { isSurfaceVisible, useSurfaceVisible } from '../../../shared/motion/surfaceVisibility';
import type { ArchitectureGraph } from '../../architecture/model/types';
import { compileReplay } from '../model/compileReplay';
import type { SessionLog } from '../model/events';
import type { ChoreographyScript } from '../model/script';
import { type LiveState, retargetLive, startLive, stepLive } from './liveDirector';
import { runLiveLoop } from './liveLoop';
import { feedSteps, simulateLive } from './simulateLive';

export interface LiveFollowSource {
  readonly log: SessionLog;
  readonly graph: ArchitectureGraph;
  /** Dev/test feed: arrival times, so a frozen clock can reproduce the director deterministically. */
  readonly simulatedFeed?: { readonly arrivalMs: readonly number[] };
}

export interface LiveFollow {
  readonly script: ChoreographyScript;
  readonly t: number;
}

const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Feeds the live director with the animation clock. The session is recompiled whenever its log
 * changes; the director decides where the playhead goes (see `liveDirector.ts`). Nothing runs while the
 * surface is hidden, and reduced motion shows the settled latest state at every update.
 * With a frozen clock (dev harness, `?t=`) a simulated feed is replayed deterministically instead.
 */
export const useLiveFollow = (source: LiveFollowSource | null): LiveFollow | null => {
  const frozen = frozenClock();
  const visible = useSurfaceVisible();
  const state = useRef<LiveState | null>(null);
  const [, repaint] = useState(0);

  const log = source?.log;
  const graph = source?.graph;
  const script = useMemo(() => (log && graph ? compileReplay(log, graph, { live: true }) : null), [log, graph]);

  const arrivals = source?.simulatedFeed?.arrivalMs;
  const frozenState = useMemo(
    () => (frozen !== null && log && graph && arrivals ? simulateLive(feedSteps(log, arrivals, graph), frozen * 1000) : null),
    [frozen, log, graph, arrivals],
  );
  // A frozen clock without a feed (nothing to replay) just shows the settled state.
  const staticMode = frozen !== null;

  // Keep the director's state in step with the projected session (idempotent, so safe to run during render).
  if (script && !staticMode) {
    const now = performance.now();
    if (!state.current) state.current = startLive(script, now);
    else if (state.current.script !== script) state.current = retargetLive(state.current, script, now);
    if (state.current.stale && visible) state.current = stepLive(state.current, now, { visible: true, reducedMotion: prefersReducedMotion() });
  }

  useEffect(() => {
    if (!script || staticMode || !state.current) return;
    const reduced = prefersReducedMotion();
    const ctx = { visible, reducedMotion: reduced };
    if (!visible) {
      // Hidden: no animation and no timers; the next visible step jumps to the latest state.
      state.current = stepLive(state.current, performance.now(), ctx);
      return;
    }
    const stop = runLiveLoop({
      read: () => state.current!,
      write: (next) => (state.current = next),
      ctx,
      schedule: { request: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) },
      paint: () => repaint((n) => n + 1),
    });
    return () => {
      stop();
      // Activity preserves refs while cleaning effects: mark the director stale before it is revealed.
      if (!isSurfaceVisible()) state.current = stepLive(state.current!, performance.now(), { visible: false, reducedMotion: reduced });
    };
  }, [script, visible, staticMode]);

  if (!script) return null;
  if (frozenState) return { script: frozenState.script, t: frozenState.t };
  if (staticMode) {
    const settled = startLive(script, 0);
    return { script, t: settled.t };
  }
  return { script, t: state.current?.t ?? 0 };
};
