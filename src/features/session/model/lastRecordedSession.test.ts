import { describe, expect, it } from 'vitest';
import type { SessionLog } from './events';
import { lastRecordedSession } from './lastRecordedSession';

const log: SessionLog = { id: 'fixture', agent: 'claude', project: 'Fixture', task: 'Fixture', startedAt: '2026-10-07T10:15:00Z', events: [{ kind: 'session.start', atMs: 0 }] };
describe('latest recorded session label', () => {
  it('does not invent a session from a missing or empty log', () => {
    expect(lastRecordedSession(null)).toBe('No session recorded yet');
    expect(lastRecordedSession({ ...log, events: [] })).toBe('No session recorded yet');
  });
  it('states the recorded start date/time and missing end as partial', () => {
    const text = lastRecordedSession(log, 'UTC');
    expect(text).toContain('7 Oct 2026');
    expect(text).toContain('10:15');
    expect(text).toContain('Partial');
    expect(text).toContain('no end recorded');
  });
  it('marks a session with an observed end complete', () => {
    expect(lastRecordedSession({ ...log, events: [...log.events, { kind: 'session.end', atMs: 1000, outcome: 'completed' }] }, 'UTC')).toContain('Complete');
  });
  it('marks an interrupted end partial and a resume after an end partial', () => {
    expect(lastRecordedSession({ ...log, events: [...log.events, { kind: 'session.end', atMs: 1000, outcome: 'interrupted' }] }, 'UTC')).toContain('Partial');
    expect(lastRecordedSession({ ...log, events: [...log.events, { kind: 'session.end', atMs: 1000, outcome: 'completed' }, { kind: 'session.start', atMs: 2000 }] }, 'UTC')).toContain('no end recorded');
  });
  it('does not invent a date if the recording timestamp is invalid', () => {
    expect(lastRecordedSession({ ...log, startedAt: 'invalid' }, 'UTC')).toContain('time unknown');
  });
});

it('labels a live session in progress, never Partial, while recorded/interrupted cases keep their labels', () => {
  expect(lastRecordedSession(log, 'UTC', { live: true })).toContain('Session in progress');
  expect(lastRecordedSession(log, 'UTC', { live: true })).not.toContain('Partial');
  expect(lastRecordedSession(log, 'UTC')).toContain('Partial (no end recorded)');
  expect(lastRecordedSession({ ...log, events: [...log.events, { kind: 'session.end', atMs: 1000, outcome: 'completed' }] }, 'UTC', { live: true })).toContain('Complete (end recorded)');
});
