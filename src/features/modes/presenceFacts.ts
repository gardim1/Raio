import type { RaioEvent } from '../ingest/raioEvent';
import type { SessionLog } from '../session/model/events';
import type { PresenceFact } from './companionPresence';

/** No command-text parsing: only the Core's minimized class/result evidence. */
export const factsFromEvents = (events: readonly RaioEvent[], projectId: string): readonly PresenceFact[] => {
  const tools = new Map<string, string>();
  const key = (event: RaioEvent) => JSON.stringify([event.sessionId, event.subagentId ?? 'main', event.evidence.toolUseId]);
  const checkClass = (value: string | undefined) => value === 'test' ? 'tests' : value ?? 'other';
  return events.filter((event) => event.projectId === projectId).slice().sort((a, b) => (a.sourceAt ?? a.observedAt) - (b.sourceAt ?? b.observedAt) || a.seq - b.seq).map((event): PresenceFact => {
    const source = event.source === 'fs-watch' ? 'Filesystem observation · author unknown' : event.source === 'fixture' ? 'Demo fixture' : `${event.agent === 'claude' ? 'Claude' : event.agent === 'codex' ? 'Codex' : 'Agent'} hook`;
    const base = { id: event.id, at: event.sourceAt ?? event.observedAt, ...(event.attribution === 'session' && event.sessionId ? { sessionId: event.sessionId } : {}), source };
    if (event.kind === 'session.started') return { ...base, kind: 'start' };
    if (event.kind === 'session.ended') return { ...base, kind: 'end' };
    if (event.kind === 'turn.ended') return { ...base, kind: 'turn-end' };
    if (event.kind === 'file.changed' || event.kind === 'file.edit.reported') return { ...base, kind: 'change', paths: event.paths, change: event.evidence.change ?? 'unknown' };
    if (event.kind === 'file.edit.attempted') return { ...base, kind: 'edit-attempted', paths: event.paths };
    if (event.kind === 'file.edit.failed') return { ...base, kind: 'edit-failed', paths: event.paths };
    if (event.kind === 'command.observed' && event.evidence.toolUseId) tools.set(key(event), checkClass(event.evidence.commandClass));
    if (event.kind === 'command.result') {
      const cls = event.evidence.commandClass ? event.evidence.commandClass : tools.get(key(event)) ?? 'other';
      if (event.evidence.detail === 'did-not-start') return { ...base, kind: 'command-not-started', checkClass: checkClass(cls), ...(event.evidence.program ? { program: event.evidence.program } : {}) };
      return { ...base, kind: 'check', checkClass: checkClass(cls), result: event.evidence.exitCode === undefined ? 'unknown' : event.evidence.exitCode === 0 ? 'passed' : 'failed', source: `${source}${event.evidence.exitCodeSource === 'failure-message' ? ' · exit captured from failure message' : event.evidence.exitCodeSource === 'tool-success' ? ' · tool result' : ''}` };
    }
    return { ...base, kind: 'activity' };
  });
};

/** Fixture and older adapters already carry normalized observations; never add facts from the map. */
export const factsFromLog = (log: SessionLog): readonly PresenceFact[] => {
  const start = Date.parse(log.startedAt);
  if (!Number.isFinite(start)) return [];
  return log.events.filter((event) => event.kind !== 'risk').map((event, index): PresenceFact => {
    const base = { id: `${log.id}:${index}`, sessionId: log.id, at: start + event.atMs, source: 'Recorded session log' };
    if (event.kind === 'session.start') return { ...base, kind: 'start' };
    if (event.kind === 'session.end') return { ...base, kind: 'end' };
    if (event.kind === 'file.write') return { ...base, kind: 'change', paths: [event.path], change: event.change };
    if (event.kind === 'file.attempt') return { ...base, kind: 'edit-attempted', paths: [event.path] };
    if (event.kind === 'file.failed') return { ...base, kind: 'edit-failed', paths: [event.path] };
    if (event.kind === 'command') return event.status === 'did-not-start'
      ? { ...base, kind: 'command-not-started', ...(event.program ? { program: event.program } : {}) }
      : { ...base, kind: 'check', checkClass: 'other', result: 'failed' };
    if (event.kind === 'validation' && event.status !== 'running') return { ...base, kind: 'check', checkClass: event.validation, result: event.status === 'passed' ? 'passed' : event.status === 'failed' ? 'failed' : 'unknown' };
    return { ...base, kind: 'activity' };
  });
};
