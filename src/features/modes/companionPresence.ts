import type { CoreHealth, ProjectHooksState } from '../../platform/desktopBridge';
import { isConfigFile, isDependencyManifest, isMigrationPath } from '../project/pathKinds';
import { BOB_TOTAL_SECONDS } from '../raio/bob';

export type CompanionState = 'failure' | 'attention' | 'working' | 'connected' | 'unknown' | 'disconnected';
export interface PresenceFact {
  readonly id: string;
  readonly sessionId?: string;
  readonly at: number;
  readonly kind: 'start' | 'end' | 'activity' | 'turn-end' | 'change' | 'check' | 'edit-failed';
  readonly paths?: readonly string[];
  readonly change?: 'added' | 'modified' | 'deleted' | 'unknown';
  readonly checkClass?: string;
  readonly result?: 'passed' | 'failed' | 'unknown';
  readonly source: string;
}
export interface PresenceInput {
  readonly connected: boolean;
  readonly available: boolean;
  readonly facts: readonly PresenceFact[];
  readonly core?: CoreHealth | null;
  readonly hooks?: ProjectHooksState;
}
export interface PresenceRecord {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly at: number;
  readonly historical: boolean;
  readonly kind: 'failure' | 'attention';
}
export interface CompanionPresence {
  readonly state: CompanionState;
  readonly label: string;
  readonly description: string;
  readonly records: readonly PresenceRecord[];
  readonly activeUntil: number | null;
}
/** Union of recorded facts, never a claim that one actor caused another actor's result. */
export const deriveCompanionPresence = (input: PresenceInput, now: number, timeZone?: string): CompanionPresence => {
  const facts = input.facts.filter((fact) => fact.at <= now).slice().sort((a, b) => a.at - b.at);
  const sessions = new Map<string, { open: boolean; first: number; last: number }>();
  for (const fact of facts) {
    if (!fact.sessionId) continue;
    const session = sessions.get(fact.sessionId) ?? { open: true, first: fact.at, last: fact.at };
    if (fact.kind === 'start') session.open = true;
    if (fact.kind === 'end') session.open = false;
    session.last = fact.at;
    sessions.set(fact.sessionId, session);
  }
  const open = [...sessions].filter(([, session]) => session.open).map(([id]) => id);
  const latest = [...sessions].sort((a, b) => b[1].last - a[1].last)[0]?.[0];
  const current = new Set(open.length > 0 ? open : latest ? [latest] : []);
  const firstCurrent = Math.min(...[...current].map((id) => sessions.get(id)!.first));
  const relevant = (fact: PresenceFact) => fact.sessionId ? current.has(fact.sessionId) : fact.at >= firstCurrent || sessions.size === 0;
  const clock = (at: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(at);
  const records: PresenceRecord[] = [];
  facts.forEach((fact, index) => {
    const later = facts.slice(index + 1);
    if ((fact.kind === 'check' && fact.result === 'failed') || fact.kind === 'edit-failed') {
      const passed = fact.kind === 'check' && later.some((other) => other.kind === 'check' && other.checkClass === fact.checkClass && other.result === 'passed');
      const changed = later.some((other) => other.kind === 'change');
      const older = !relevant(fact);
      const name = fact.kind === 'edit-failed' ? 'Edit' : fact.checkClass === 'tests' ? 'Tests' : fact.checkClass === 'build' ? 'Build' : 'Command';
      const historical = passed || changed || older;
      const reason = passed ? 'Failed earlier · later pass recorded' : changed ? 'Failed earlier · code changed since' : older ? 'Failed earlier · earlier session' : `${name} failed`;
      records.push({ id: fact.id, kind: 'failure', at: fact.at, historical, label: `${reason} · ${clock(fact.at)}`, source: [fact.source, ...(fact.paths ?? [])].join(' · ') });
    }
    if (fact.kind !== 'change') return;
    for (const path of fact.paths ?? []) {
      const label = isMigrationPath(path) && fact.change === 'added' ? 'Migration file added' : isDependencyManifest(path) ? 'Dependency manifest changed' : isConfigFile(path) ? (/^\.env(?:\.|$)/i.test(path.split('/').at(-1)!) ? 'Sensitive file changed' : 'Configuration file changed') : null;
      if (label) records.push({ id: `${fact.id}:${path}`, kind: 'attention', at: fact.at, historical: !relevant(fact), label: `${label} · ${clock(fact.at)}`, source: `${fact.source} · ${path} (path-name heuristic)` });
    }
  });
  const warn = (id: string, label: string) => records.push({ id, kind: 'attention', at: now, historical: false, label, source: 'Local core status' });
  if (input.core && (input.core.dropped > 0 || input.core.droppedAtLeast)) warn('dropped', 'Some events may not have been recorded');
  if (input.core?.watcherOverflow) warn('overflow', 'File watcher overflowed');
  if (input.core?.historyResetFrom) warn('history', 'Earlier history unavailable');
  if (input.hooks === 'outdated') warn('hooks', 'Hooks outdated');
  const recent = facts.filter((fact) => fact.kind !== 'end' && relevant(fact) && (!fact.sessionId || sessions.get(fact.sessionId)?.open));
  const activeUntil = recent.length ? recent.at(-1)!.at + BOB_TOTAL_SECONDS * 1000 : null;
  const active = activeUntil !== null && activeUntil > now;
  const newest = records.slice().reverse();
  const failure = newest.find((record) => record.kind === 'failure' && !record.historical);
  const attention = newest.find((record) => record.kind === 'attention' && !record.historical);
  const state: CompanionState = !input.connected ? 'disconnected' : !input.available ? 'unknown' : failure ? 'failure' : attention ? 'attention' : active ? 'working' : 'connected';
  const label = state === 'disconnected' ? 'Disconnected · no project' : state === 'unknown' ? 'Status unavailable' : state === 'failure' ? failure!.label : state === 'attention' ? attention!.label : state === 'working' ? 'Recent activity' : 'Connected · quiet';
  const chosen = state === 'failure' ? failure : state === 'attention' ? attention : undefined;
  return { state, label, description: chosen ? `${chosen.label} · ${chosen.source}` : label, records, activeUntil: active ? activeUntil : null };
};
