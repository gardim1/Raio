import { describe, expect, it } from 'vitest';
import type { SessionLog } from '../model/events';
import { shouldReturnToLive, trackReplayActivity } from './replayActivity';

const log: SessionLog = { id: 'session-a', agent: 'claude', task: 'Fixture', project: 'Fixture', startedAt: '2026-10-07T00:00:00Z', events: [{ kind: 'session.start', atMs: 0 }, { kind: 'session.end', atMs: 1000, outcome: 'completed' }] };
const previous = { projectKey: 'project-a', log, complete: true };
const resumed: SessionLog = { ...log, events: [...log.events, { kind: 'session.start', atMs: 2000 }] };
const next = { projectKey: 'project-a', log: resumed, complete: false };
const options = { followsLive: true, isReplay: true, playing: false };

describe('new activity after a completed replay', () => {
  it('returns to live for resumed activity even if recompilation makes the new replay incomplete', () => {
    expect(shouldReturnToLive(previous, next, options)).toBe(true);
  });

  it('returns for a new session in the same connected project', () => {
    expect(shouldReturnToLive(previous, { ...next, log: { ...resumed, id: 'session-b' } }, options)).toBe(true);
  });

  it('does not interrupt a replay that is still playing', () => {
    expect(shouldReturnToLive(previous, next, { ...options, playing: true })).toBe(false);
  });

  it('does not interrupt a paused unfinished replay', () => {
    expect(shouldReturnToLive({ ...previous, complete: false }, next, options)).toBe(false);
  });

  it('ignores an ordinary snapshot refresh with no new activity', () => {
    expect(shouldReturnToLive(previous, { ...previous, log: { ...log, events: log.events.map((event) => ({ ...event })) } }, options)).toBe(false);
  });

  it('ignores area remapping of the same observed file event', () => {
    const before: SessionLog = { ...log, events: [{ kind: 'file.write', atMs: 5, path: 'src/a.ts', nodeId: 'other', change: 'modified' }] };
    const after: SessionLog = { ...before, events: [{ kind: 'file.write', atMs: 5, path: 'src/a.ts', nodeId: 'api', change: 'modified' }] };
    expect(shouldReturnToLive({ ...previous, log: before }, { ...previous, log: after }, options)).toBe(false);
  });

  it('recognizes additional occurrences even with identical normalized event contents', () => {
    expect(shouldReturnToLive(previous, { ...next, log: { ...log, events: [...log.events, log.events[0]!] } }, options)).toBe(true);
  });

  it('ignores another project, initial rendering, plain demo playback and the live view', () => {
    expect(shouldReturnToLive(previous, { ...next, projectKey: 'project-b' }, options)).toBe(false);
    expect(shouldReturnToLive(null, next, options)).toBe(false);
    expect(shouldReturnToLive(previous, next, { ...options, followsLive: false })).toBe(false);
    expect(shouldReturnToLive(previous, next, { ...options, isReplay: false })).toBe(false);
  });
});

describe('pending activity during a replay', () => {
  const state = { previous: { ...previous, complete: false }, pending: false, run: 1 };
  const running = { ...options, playing: true, run: 1 };
  it('keeps a playing replay open and retains a visible pending flag', () => {
    const update = trackReplayActivity(state, next, running);
    expect(update.pending).toBe(true);
    expect(update.returnToLive).toBe(false);
  });
  it('returns on completion even when no further event arrives after the earlier activity', () => {
    const pending = { previous: next, pending: true, run: 1 };
    const stopped = trackReplayActivity(pending, { ...next, complete: true }, { ...running, playing: false });
    expect(stopped.returnToLive).toBe(true);
  });
  it('keeps pending activity across a paused unfinished replay', () => {
    const update = trackReplayActivity({ previous: next, pending: true, run: 1 }, next, { ...running, playing: false });
    expect(update.pending).toBe(true);
    expect(update.returnToLive).toBe(false);
  });
  it('clears pending after returning live and when switching projects or restarting the replay', () => {
    const pending = { previous: next, pending: true, run: 1 };
    expect(trackReplayActivity(pending, next, { ...running, isReplay: false }).pending).toBe(false);
    expect(trackReplayActivity(pending, { ...next, projectKey: 'other' }, running).pending).toBe(false);
    expect(trackReplayActivity(pending, next, { ...running, run: 2 }).pending).toBe(false);
  });
  it('does not mark an equivalent map/health refresh as new activity', () => {
    const same = { ...state.previous, log: { ...log, events: log.events.map((event) => ({ ...event })) } };
    expect(trackReplayActivity(state, same, running).pending).toBe(false);
  });
  it('stops the old project replay when another native window selects a different project', () => {
    const update = trackReplayActivity(state, { ...next, projectKey: 'project-b' }, running);
    expect(update.returnToLive).toBe(true);
    expect(update.pending).toBe(false);
    expect(trackReplayActivity(state, { ...next, projectKey: 'project-b' }, { ...running, followsLive: false }).returnToLive).toBe(false);
  });
});
