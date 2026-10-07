import type { AgentEvent, SessionLog } from '../model/events';

export interface ReplayActivitySnapshot {
  readonly projectKey: string;
  readonly log: SessionLog;
  readonly complete: boolean;
}

/** Map classifications can change after a scan; they do not make an observed event new. */
const activityKey = (event: AgentEvent): string => {
  switch (event.kind) {
    case 'session.start': return JSON.stringify([event.kind, event.atMs]);
    case 'session.end': return JSON.stringify([event.kind, event.atMs, event.outcome]);
    case 'file.read': return JSON.stringify([event.kind, event.atMs, event.path]);
    case 'file.write': return JSON.stringify([event.kind, event.atMs, event.path, event.change]);
    case 'risk': return JSON.stringify([event.kind, event.atMs, event.risk, event.detail]);
    case 'validation': return JSON.stringify([event.kind, event.atMs, event.validation, event.status, event.detail ?? null]);
  }
};

/** Use the previously displayed completion, before new activity recompiles/lengthens the replay. */
export const shouldReturnToLive = (
  previous: ReplayActivitySnapshot | null,
  next: ReplayActivitySnapshot,
  options: { followsLive: boolean; isReplay: boolean; playing: boolean },
): boolean => {
  if (!options.followsLive || !options.isReplay || options.playing || !previous?.complete || previous.projectKey !== next.projectKey) return false;
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
