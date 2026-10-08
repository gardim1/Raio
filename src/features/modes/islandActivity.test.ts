import { expect, it } from 'vitest';
import { islandActivity, islandPresenceActivity } from './islandActivity';
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
it('pre-session activity shows the latest recorded source and time, excluding future facts', () => {
  expect(islandPresenceActivity([
    { id: 'b', kind: 'change', at: 65_000, source: 'Fixture watcher' },
    { id: 'a', kind: 'activity', at: 0, source: 'Earlier hook' },
    { id: 'future', kind: 'activity', at: 100_000, source: 'Future fact' },
  ], 70_000, 'UTC')).toBe('Fixture watcher · 00:01');
  expect(islandPresenceActivity([], 0)).toBe('Activity details unavailable');
});
