import type { AgentEvent, SessionLog } from '../model/events';

export interface ReplayActivitySnapshot {
  readonly projectKey: string;
  readonly log: SessionLog;
  readonly complete: boolean;
}

export interface ReplayActivityState {
  readonly previous: ReplayActivitySnapshot | null;
  readonly pending: boolean;
  readonly run: number;
}
export const trackReplayActivity = (state: ReplayActivityState, next: ReplayActivitySnapshot, options: { followsLive: boolean; isReplay: boolean; playing: boolean; run: number }): ReplayActivityState & { returnToLive: boolean } => {
  const projectChanged = state.previous !== null && state.previous.projectKey !== next.projectKey;
  const reset = !options.followsLive || !options.isReplay || state.run !== options.run || projectChanged;
  const pending = !reset && (state.pending || (state.previous !== null && hasNewActivity(state.previous, next)));
  const returnToLive = (options.followsLive && options.isReplay && projectChanged) || (!reset && (shouldReturnToLive(state.previous, next, options) || (pending && !options.playing && next.complete)));
  return { previous: next, pending, run: options.run, returnToLive };
};

/** Map classifications can change after a scan; they do not make an observed event new. */
const activityKey = (event: AgentEvent): string => {
  switch (event.kind) {
    case 'session.start': return JSON.stringify([event.kind, event.atMs]);
    case 'session.end': return JSON.stringify([event.kind, event.atMs, event.outcome]);
    case 'file.read': return JSON.stringify([event.kind, event.atMs, event.path]);
    case 'file.write': return JSON.stringify([event.kind, event.atMs, event.path, event.change]);
    case 'file.attempt':
    case 'file.failed': return JSON.stringify([event.kind, event.atMs, event.path]);
    case 'command': return JSON.stringify([event.kind, event.atMs, event.program ?? null, event.status, event.detail ?? null]);
    case 'risk': return JSON.stringify([event.kind, event.atMs, event.risk, event.detail]);
    case 'validation': return JSON.stringify([event.kind, event.atMs, event.validation, event.status, event.detail ?? null, event.program ?? null]);
  }
};

/** Use the previously displayed completion, before new activity recompiles/lengthens the replay. */
export const shouldReturnToLive = (
  previous: ReplayActivitySnapshot | null,
  next: ReplayActivitySnapshot,
  options: { followsLive: boolean; isReplay: boolean; playing: boolean },
): boolean => {
  if (!options.followsLive || !options.isReplay || options.playing || !previous?.complete || previous.projectKey !== next.projectKey) return false;
  return hasNewActivity(previous, next);
};

const hasNewActivity = (previous: ReplayActivitySnapshot, next: ReplayActivitySnapshot): boolean => {
  if (previous.log.id !== next.log.id) return next.log.events.length > 0;
  if (previous.log === next.log) return false;
  const seen = new Map<string, number>();
  for (const event of previous.log.events) {
    const key = activityKey(event);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const event of next.log.events) {
    const key = activityKey(event);
    const remaining = seen.get(key) ?? 0;
    if (remaining === 0) return true;
    seen.set(key, remaining - 1);
  }
  return false;
};
