import { expect, it } from 'vitest';
import { islandActivity, islandObservedActivity, islandPresenceActivity } from './islandActivity';
import type { PresenceFact } from './companionPresence';
import type { SessionLog } from '../session/model/events';
const log: SessionLog = { id: 'fixture', project: 'folder', agent: 'claude', task: 'Observed activity', startedAt: '2026-10-08T12:00:00Z', events: [] };
it('absence of telemetry is unknown, never working', () => {
  expect(islandActivity(null)).toBe('No activity observed');
  expect(islandActivity(log)).toBe('No activity observed');
});
it('shows the latest observed operation with its time, never the animation task', () => {
  expect(islandActivity({ ...log, events: [{ kind: 'session.start', atMs: 0 }, { kind: 'file.read', atMs: 65_000, path: 'src/api.ts', nodeId: 'api' }] }, 'UTC')).toBe('Read src/api.ts · 12:01');
});
it('turn end is separate from check results, and unknown results stay unknown', () => {
  expect(islandActivity({ ...log, events: [{ kind: 'validation', atMs: 0, validation: 'tests', status: 'unknown' }] }, 'UTC')).toBe('Tests unknown · 12:00');
  expect(islandActivity({ ...log, events: [{ kind: 'validation', atMs: 0, validation: 'tests', status: 'failed' }, { kind: 'session.end', atMs: 60_000, outcome: 'completed' }] }, 'UTC')).toBe('Turn ended · 12:01');
});
it('shows edit failures with their path and failed starts without claiming a test failure', () => {
  expect(islandActivity({ ...log, events: [{ kind: 'file.failed', atMs: 1000, path: 'src/a.ts', nodeId: 'src' }] }, 'UTC')).toBe('Edit failed · src/a.ts · 12:00');
  expect(islandActivity({ ...log, events: [{ kind: 'validation', atMs: 1000, validation: 'tests', status: 'unknown', detail: 'did-not-start', program: 'python' }] }, 'UTC')).toBe('Could not start python — check did not run · 12:00');
});
it('pre-session activity shows the latest recorded source and time, excluding future facts', () => {
  expect(islandPresenceActivity([
    { id: 'b', kind: 'change', at: 65_000, source: 'Fixture watcher' },
    { id: 'a', kind: 'activity', at: 0, source: 'Earlier hook' },
    { id: 'future', kind: 'activity', at: 100_000, source: 'Future fact' },
  ], 70_000, 'UTC')).toBe('Fixture watcher · 00:01');
  expect(islandPresenceActivity([], 0)).toBe('Activity details unavailable');
});
it.each([
  [{ kind: 'edit-failed', paths: ['src/a.ts'] }, 'Edit failed · src/a.ts · 14:04 · Claude hook'],
  [{ kind: 'command-not-started', program: 'python' }, 'Could not start python — check did not run · 14:04 · Claude hook'],
  [{ kind: 'check', checkClass: 'tests', result: 'unknown' }, 'Tests unknown (recorded) · 14:04 · Claude hook'],
  [{ kind: 'check', checkClass: 'other', result: 'passed' }, 'Command passed (recorded) · 14:04 · Claude hook'],
] as const)('latest fact preserves its kind/result and evidence source: %j', (detail, expected) => {
  const fact: PresenceFact = { id: 'latest', at: Date.parse('2026-10-08T14:04:00Z'), source: 'Claude hook', ...detail };
  expect(islandObservedActivity([fact, { id: 'earlier', kind: 'activity', at: fact.at - 1000, source: 'Earlier hook' }, { id: 'future', kind: 'check', result: 'passed', at: fact.at + 1000, source: 'Future hook' }], fact.at, 'UTC')).toBe(expected);
});
it('reports watcher-only changes as source unknown without the generic Last activity claim', () => {
  const fact: PresenceFact = { id: 'watcher', kind: 'change', at: Date.parse('2026-10-08T14:04:00Z'), source: 'Filesystem observation · author unknown', paths: ['src/a.ts'] };
  expect(islandObservedActivity([fact], fact.at, 'UTC')).toBe('File changed — source unknown · 14:04');
});
it('no available presence facts never falls back to claiming newer activity or check success', () => {
  expect(islandObservedActivity([], 0, 'UTC')).toBe('No activity observed');
});
it('a distinct turn end never becomes a command or a check result', () => {
  const at = Date.parse('2026-10-08T14:03:00Z');
  const facts: PresenceFact[] = [
    { id: 'command', kind: 'activity', at: at - 60_000, source: 'Claude hook' },
    { id: 'stop', kind: 'turn-end', at, source: 'Claude hook' },
  ];
  expect(islandObservedActivity(facts, at - 60_000, 'UTC')).toBe('Activity observed · 14:02 · Claude hook');
  const ended = islandObservedActivity(facts, at, 'UTC');
  expect(ended).toBe('Turn ended · 14:03 · Claude hook');
  expect(ended).not.toMatch(/command|check|test|passed|failed|unknown/i);
});
