import type { SessionLog } from './events';

export const lastRecordedSession = (log: SessionLog | null, timeZone?: string): string => {
  if (!log || log.events.length === 0) return 'No session recorded yet';
  const date = new Date(log.startedAt);
  const when = Number.isNaN(date.getTime()) ? 'time unknown' : new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const boundary = log.events.filter((event) => event.kind === 'session.start' || event.kind === 'session.end').at(-1);
  const status = boundary?.kind !== 'session.end' ? 'Partial (no end recorded)' : boundary.outcome === 'interrupted' ? 'Partial (interrupted)' : 'Complete (end recorded)';
  return `Last recorded session: ${when} · ${status}`;
};
