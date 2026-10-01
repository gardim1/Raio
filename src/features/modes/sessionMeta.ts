import { useSessionSnapshot } from '../../platform/BridgeContext';

/** HH:MM (24h) of an ISO timestamp in the viewer's zone (or `timeZone`); null when absent or unparsable. */
export const formatClockTime = (iso: string | undefined, timeZone?: string): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(date);
};

export interface SessionMeta {
  readonly project: string;
  /** Local HH:MM the session started, or null when unknown. */
  readonly startedAt: string | null;
}

/** Session facts the surfaces show but the animation script does not carry (project name, start time). */
export const useSessionMeta = (): SessionMeta => {
  const snapshot = useSessionSnapshot();
  return { project: snapshot?.project ?? '', startedAt: formatClockTime(snapshot?.log.startedAt) };
};
