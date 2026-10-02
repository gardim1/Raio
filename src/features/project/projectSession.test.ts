import { describe, expect, it } from 'vitest';
import type { CommandClass, EventAgent, RaioEvent, RaioEventEvidence, RaioEventKind } from '../ingest/raioEvent';
import { compileReplay } from '../session/model/compileReplay';
import { AGENT_LABEL, type AgentEvent } from '../session/model/events';
import { deriveInsights } from '../session/model/insights';
import { DISK_WINDOW_MS } from './diskEvidence';
import { HEURISTIC_NOTE } from './classifyPath';
import type { ProjectImports } from './importEdges';
import { projectSession, projectSessionDetailed } from './projectSession';

const PROJECT = { id: 'p1', name: 'acme-mini' };
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

let seq = 0;
const ev = (kind: RaioEventKind, atSec: number, paths: string[] = [], evidence: RaioEventEvidence = {}, extra: Partial<RaioEvent> = {}): RaioEvent => {
  seq += 1;
  return {
    schema: 1,
    id: `e${seq}`,
    source: 'claude-hook',
    provenance: 'agent-reported',
    attribution: 'session',
    projectId: PROJECT.id,
    sessionId: 's1',
    agent: 'claude',
    sourceAt: T0 + atSec * 1000,
    observedAt: T0 + atSec * 1000 + 40,
    seq,
    kind,
    paths,
    evidence,
    ...extra,
  };
};
const disk = (atSec: number, path: string, extra: Partial<RaioEvent> = {}): RaioEvent =>
  ev('file.changed', atSec, [path], {}, { source: 'fs-watch', provenance: 'filesystem-observed', attribution: 'unassigned', agent: 'unknown', sessionId: undefined, ...extra });
const started = (atSec = 0, extra: Partial<RaioEvent> = {}) => ev('session.started', atSec, [], { detail: 'startup' }, extra);
const ended = (atSec: number, extra: Partial<RaioEvent> = {}) => ev('session.ended', atSec, [], { detail: 'other' }, extra);
const read = (atSec: number, path: string, extra: Partial<RaioEvent> = {}) => ev('file.inspected', atSec, [path], { toolName: 'Read' }, extra);
const edit = (atSec: number, path: string, change?: 'added' | 'modified' | 'deleted' | 'unknown', extra: Partial<RaioEvent> = {}) =>
  ev('file.edit.reported', atSec, [path], { toolName: 'Write', ...(change ? { change } : {}) }, extra);
const observed = (atSec: number, toolUseId: string, commandClass: CommandClass) => ev('command.observed', atSec, [], { toolUseId, toolName: 'Bash', commandClass, program: 'npm' });
const result = (atSec: number, toolUseId: string, exitCode?: number) =>
  ev('command.result', atSec, [], {
    toolUseId,
    toolName: 'Bash',
    ...(exitCode === undefined ? {} : { exitCode, exitCodeSource: exitCode === 0 ? ('tool-success' as const) : ('failure-message' as const) }),
  });

const project = (events: readonly RaioEvent[], sessionId?: string) => {
  const snapshot = projectSession(PROJECT, events, sessionId);
  if (!snapshot) throw new Error('expected a snapshot');
  return snapshot;
};
const detailed = (events: readonly RaioEvent[], sessionId?: string) => {
  const projected = projectSessionDetailed(PROJECT, events, sessionId);
  if (!projected) throw new Error('expected a projection');
  return projected;
};
const eventsOf = (events: readonly RaioEvent[], sessionId?: string): readonly AgentEvent[] => project(events, sessionId).log.events;
const validationsOf = (events: readonly RaioEvent[], sessionId?: string) => eventsOf(events, sessionId).filter((e) => e.kind === 'validation');

describe('projectSession: telemetry', () => {
  it('returns null when there are no events at all', () => {
    expect(projectSession(PROJECT, [])).toBeNull();
  });

  it('returns null when only disk changes exist (no agent telemetry)', () => {
    expect(projectSession(PROJECT, [disk(1, 'src/a.ts'), disk(2, 'README.md')])).toBeNull();
  });

  it('returns null for events that belong to another project', () => {
    expect(projectSession(PROJECT, [started(0, { projectId: 'other' }), edit(1, 'src/a.ts', 'added', { projectId: 'other' })])).toBeNull();
  });

  it('does not treat events without session attribution as agent activity', () => {
    const unattributed = [edit(1, 'src/a.ts', 'added', { attribution: 'unassigned' }), edit(2, 'src/b.ts', 'added', { sessionId: undefined })];
    expect(projectSession(PROJECT, unattributed)).toBeNull();
  });

  it('returns null for a session id that has no events', () => {
    expect(projectSession(PROJECT, [started(0), edit(1, 'src/a.ts')], 'missing')).toBeNull();
  });

  it('picks the most recent session by default and the requested one when given', () => {
    const events = [
      started(0, { sessionId: 'old' }),
      edit(5, 'src/old.ts', 'added', { sessionId: 'old' }),
      started(100, { sessionId: 'new' }),
      edit(110, 'src/new.ts', 'added', { sessionId: 'new' }),
    ];
    expect(project(events).log.id).toBe('new');
    expect(project(events, 'old').log.id).toBe('old');
  });

  it('marks the snapshot live, or fixture when the events are fixtures', () => {
    expect(project([started(0), edit(1, 'src/a.ts')]).provenance).toBe('live');
    expect(project([started(0, { provenance: 'fixture', source: 'fixture' }), edit(1, 'src/a.ts')]).provenance).toBe('fixture');
  });
});

describe('projectSession: session log', () => {
  it('orders by source time then seq, and measures time from the session start', () => {
    const a = edit(10, 'src/a.ts', 'added');
    const b = edit(10, 'src/b.ts', 'added');
    const s = started(2);
    const c = edit(4, 'src/c.ts', 'added');
    const log = project([b, c, a, s]).log;
    expect(log.events.map((e) => (e.kind === 'file.write' ? e.path : e.kind))).toEqual(['session.start', 'src/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(log.events.map((e) => e.atMs)).toEqual([0, 2000, 8000, 8000]);
  });

  it('falls back to the ingestion time when the producer gave none', () => {
    const noSource = { ...edit(0, 'src/a.ts', 'added'), sourceAt: undefined, observedAt: T0 + 9000 };
    const log = project([started(5), noSource]).log;
    expect(log.events.find((e) => e.kind === 'file.write')?.atMs).toBe(4000);
  });

  it('records a neutral task with the local start time and never invents one', () => {
    const log = project([started(0), edit(1, 'src/a.ts')]).log;
    const d = new Date(T0);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(log.task).toBe(`Session started ${hhmm}`);
    expect(log.startedAt).toBe(new Date(T0).toISOString());
    expect(log.project).toBe('acme-mini');
  });

  it('maps reads, reported edits and defaults an unspecified change to modified', () => {
    const events = eventsOf([started(0), read(1, 'src/auth/session.ts'), edit(2, 'src/auth/login.ts', 'added'), edit(3, 'src/auth/login.ts'), edit(4, 'src/api/x.ts', 'deleted'), edit(5, 'src/api/y.ts', 'unknown')]);
    expect(events).toEqual([
      { kind: 'session.start', atMs: 0 },
      { kind: 'file.read', atMs: 1000, path: 'src/auth/session.ts', nodeId: 'auth' },
      { kind: 'file.write', atMs: 2000, path: 'src/auth/login.ts', nodeId: 'auth', change: 'added' },
      { kind: 'file.write', atMs: 3000, path: 'src/auth/login.ts', nodeId: 'auth', change: 'modified' },
      { kind: 'file.write', atMs: 4000, path: 'src/api/x.ts', nodeId: 'api', change: 'deleted' },
      { kind: 'file.write', atMs: 5000, path: 'src/api/y.ts', nodeId: 'api', change: 'modified' },
    ]);
  });

  it('does not turn attempted or failed edits, or turn endings, into writes or completion', () => {
    const events = eventsOf([started(0), ev('file.edit.attempted', 1, ['src/a.ts']), ev('file.edit.failed', 2, ['src/b.ts']), ev('turn.ended', 3)]);
    expect(events).toEqual([{ kind: 'session.start', atMs: 0 }]);
  });

  it('builds a map of the touched groups with no edges and says relationships are unknown', () => {
    const projected = detailed([started(0), edit(1, 'src/auth/a.ts'), edit(2, 'src/api/b.ts'), read(3, 'docs/x.md')]);
    const graph = projected.snapshot.graph;
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['api', 'auth', 'docs']);
    expect(graph.edges).toEqual([]);
    expect(projected.insights.relationships).toBe('unknown');
    expect(projected.insights.note).toMatch(/heuristic/i);
  });

  it('merges groups beyond the cap into Other and points the log at it', () => {
    const edits = Array.from({ length: 15 }, (_, i) => edit(i + 1, `dir${String(i).padStart(2, '0')}/f.ts`, 'added'));
    const snapshot = project([started(0), ...edits]);
    expect(snapshot.graph.nodes).toHaveLength(13);
    const write = snapshot.log.events.find((e) => e.kind === 'file.write' && e.path === 'dir14/f.ts');
    expect(write && write.kind === 'file.write' && snapshot.graph.nodeById.get(write.nodeId)?.label).toBe('Other');
    for (const e of snapshot.log.events) if (e.kind === 'file.write') expect(snapshot.graph.nodeById.has(e.nodeId)).toBe(true);
  });

  it('handles a session that touched no files: empty map, replay still compiles', () => {
    const snapshot = project([started(0), observed(1, 't1', 'test')]);
    expect(snapshot.graph.nodes).toEqual([]);
    expect(() => compileReplay(snapshot.log, snapshot.graph)).not.toThrow();
  });

  it('runs through compileReplay and deriveInsights unchanged', () => {
    const snapshot = project([started(0), read(1, 'src/auth/a.ts'), edit(2, 'src/auth/b.ts', 'added'), edit(3, 'src/api/c.ts'), ended(9)]);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.nodes.map((n) => n.nodeId).sort()).toEqual(['api', 'auth']);
    expect(script.edges).toEqual([]);
    expect(deriveInsights(snapshot.log).filesChanged).toBe(2);
  });
});

describe('projectSession: agents', () => {
  it('shows an unidentified agent as Agent, never as Claude', () => {
    const snapshot = project([started(0, { agent: 'unknown' }), edit(1, 'src/auth/a.ts', 'added', { agent: 'unknown' }), ended(5, { agent: 'unknown' })]);
    expect(snapshot.log.agent).toBe('unknown');
    expect(AGENT_LABEL[snapshot.log.agent]).toBe('Agent');
    const story = compileReplay(snapshot.log, snapshot.graph).story.map((s) => s.label);
    expect(story.some((l) => l.startsWith('Agent started'))).toBe(true);
    expect(story.some((l) => l.includes('Claude'))).toBe(false);
  });

  it('keeps codex as codex', () => {
    expect(project([started(0, { agent: 'codex' }), edit(1, 'src/a.ts', 'added', { agent: 'codex' })]).log.agent).toBe('codex');
  });

  it('uses the agent of the first agent event when the session start is missing', () => {
    const agent: EventAgent = 'codex';
    expect(project([edit(1, 'src/a.ts', 'added', { agent })]).log.agent).toBe('codex');
  });
});

describe('projectSession: session end', () => {
  it('maps session.ended to a completed end', () => {
    const log = project([started(0), edit(1, 'src/a.ts'), ended(7)]).log;
    expect(log.events.at(-1)).toEqual({ kind: 'session.end', atMs: 7000, outcome: 'completed' });
  });

  it('adds no end when the session never ended, and the replay is incomplete', () => {
    const snapshot = project([started(0), edit(1, 'src/auth/a.ts')]);
    expect(snapshot.log.events.some((e) => e.kind === 'session.end')).toBe(false);
    expect(compileReplay(snapshot.log, snapshot.graph).status.at(-1)?.state).toBe('incomplete');
  });
});

describe('projectSession: validations', () => {
  const base = [started(0), edit(1, 'src/auth/a.ts')];

  it('records a test command as running until its result arrives', () => {
    expect(validationsOf([...base, observed(2, 't1', 'test')])).toEqual([{ kind: 'validation', atMs: 2000, validation: 'tests', status: 'running' }]);
  });

  it('turns a running check without a result into incomplete in the replay', () => {
    const snapshot = project([...base, observed(2, 't1', 'build'), ended(9)]);
    expect(compileReplay(snapshot.log, snapshot.graph).validations.map((v) => v.status)).toEqual(['incomplete']);
  });

  it('maps build and test classes, and ignores other command classes', () => {
    const kinds = validationsOf([...base, observed(2, 'b', 'build'), observed(3, 'x', 'install'), observed(4, 'y', 'other'), observed(5, 'm', 'migration'), observed(6, 't', 'test')]).map((e) => (e.kind === 'validation' ? e.validation : ''));
    expect(kinds).toEqual(['build', 'tests']);
  });

  it('maps exit 0 to passed, a positive exit to failed, and no exit code to unknown', () => {
    const status = (code?: number) => {
      const v = validationsOf([...base, observed(2, 't1', 'test'), result(3, 't1', code)]).at(-1);
      return v && v.kind === 'validation' ? v.status : undefined;
    };
    expect(status(0)).toBe('passed');
    expect(status(1)).toBe('failed');
    expect(status(3)).toBe('failed');
    expect(status(undefined)).toBe('unknown');
  });

  it('ignores a result for a command that was neither a test nor a build', () => {
    expect(validationsOf([...base, observed(2, 'o', 'other'), result(3, 'o', 0)])).toEqual([]);
    expect(validationsOf([...base, result(3, 'unseen', 0)])).toEqual([]);
  });

  it('lets a later passing run replace an earlier failing one', () => {
    const last = validationsOf([...base, observed(2, 't1', 'test'), result(3, 't1', 1), observed(4, 't2', 'test'), result(5, 't2', 0)]).at(-1);
    expect(last).toMatchObject({ validation: 'tests', status: 'passed' });
  });

  it('keeps a failure a failure in the replay summary', () => {
    const snapshot = project([...base, observed(2, 't1', 'test'), result(3, 't1', 1), ended(9)]);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.status.at(-1)?.state).toBe('failed');
    expect(script.summary.checks).toBe('some-failed');
  });
});

describe('projectSession: disk consistency and attribution', () => {
  it('reports a reported edit with no disk change as reported only', () => {
    const { insights, snapshot } = detailed([started(0), edit(10, 'src/auth/a.ts', 'added'), ended(20)]);
    expect(insights.reportedEdits).toEqual([{ path: 'src/auth/a.ts', groupId: 'auth', atMs: 10_000, disk: 'not-observed', confidence: 'medium', concurrentChange: false }]);
    expect(snapshot.log.events.filter((e) => e.kind === 'file.write')).toHaveLength(1);
  });

  it('marks a reported edit consistent when the watcher saw the same path within the window', () => {
    const { insights } = detailed([started(0), edit(10, 'src/auth/a.ts', 'added'), disk(10 + DISK_WINDOW_MS / 1000 - 1, 'src/auth/a.ts')]);
    expect(insights.reportedEdits[0]).toMatchObject({ disk: 'consistent', confidence: 'high', concurrentChange: false });
    expect(insights.unassigned).toEqual([]);
  });

  it('shows a disk change nobody reported as unassigned, and never as an agent write', () => {
    const { insights, snapshot } = detailed([started(0), edit(1, 'src/auth/a.ts', 'added'), disk(30, 'src/web/b.ts'), ended(40)]);
    expect(insights.unassigned).toEqual([{ path: 'src/web/b.ts', groupId: 'web', groupLabel: 'Web', atMs: 30_000, notice: null }]);
    expect(snapshot.log.events.filter((e) => e.kind === 'file.write').map((e) => (e.kind === 'file.write' ? e.path : ''))).toEqual(['src/auth/a.ts']);
    expect(snapshot.graph.nodeById.has('web')).toBe(false);
    expect(insights.unassigned[0]).not.toHaveProperty('change');
  });

  it('lowers confidence when a concurrent change hits the same path inside the window', () => {
    const { insights, snapshot } = detailed([started(0), edit(10, 'src/auth/a.ts', 'modified'), disk(10.3, 'src/auth/a.ts'), disk(13, 'src/auth/a.ts')]);
    expect(insights.reportedEdits[0]).toMatchObject({ disk: 'consistent', confidence: 'low', concurrentChange: true });
    expect(insights.unassigned.map((u) => u.atMs)).toEqual([13_000]);
    expect(snapshot.log.events.filter((e) => e.kind === 'file.write')).toHaveLength(1);
  });

  it('only lists unassigned changes that happened during the session', () => {
    const { insights } = detailed([disk(-60, 'src/before.ts'), started(0), edit(1, 'src/a.ts'), ended(10), disk(12, 'src/during.ts'), disk(10 + DISK_WINDOW_MS / 1000 + 600, 'src/after.ts')]);
    expect(insights.unassigned.map((u) => u.path)).toEqual(['src/during.ts']);
  });

  it('matches changes against edits reported by any session of the project', () => {
    // s1 reported the edit; the change at 11 s falls inside s2's span but belongs to s1's edit, so it is not "unknown author".
    const events = [started(0), edit(10, 'src/a.ts', 'added'), started(5, { sessionId: 's2' }), edit(6, 'src/b.ts', 'added', { sessionId: 's2' }), disk(11, 'src/a.ts')];
    expect(detailed(events, 's2').insights.unassigned).toEqual([]);
  });
});

describe('projectSession: stale validations', () => {
  const run = (testAtSec: number, status: number) => [observed(testAtSec - 1, `t${testAtSec}`, 'test'), result(testAtSec, `t${testAtSec}`, status)];

  it('marks passing tests stale when a human edit changes the project afterwards', () => {
    const events = [started(0), edit(1, 'src/auth/a.ts', 'added'), disk(1.2, 'src/auth/a.ts'), ...run(10, 0), disk(30, 'src/auth/a.ts'), ended(40)];
    const projected = detailed(events);
    const last = projected.snapshot.log.events.filter((e) => e.kind === 'validation').at(-1);
    expect(last).toMatchObject({ validation: 'tests', status: 'stale' });
    expect(projected.insights.validations.at(-1)).toMatchObject({ kind: 'tests', status: 'stale', recordedStatus: 'passed', staleSinceMs: 30_000 });
    const script = compileReplay(projected.snapshot.log, projected.snapshot.graph);
    expect(script.story.map((s) => s.label)).toContain('Tests: stale (code changed after the run)');
    expect(script.summary.checks).toBe('unverified');
  });

  it('keeps tests passed when the only later disk event is the echo of an earlier reported edit', () => {
    const events = [started(0), edit(9, 'src/auth/a.ts', 'added'), ...run(10, 0), disk(11, 'src/auth/a.ts'), ended(40)];
    expect(validationsOf(events).at(-1)).toMatchObject({ status: 'passed' });
  });

  it('marks tests stale when the agent itself reports another edit afterwards, even without a watcher', () => {
    const events = [started(0), ...run(10, 0), edit(20, 'src/auth/a.ts', 'modified'), ended(40)];
    expect(validationsOf(events).at(-1)).toMatchObject({ status: 'stale' });
  });

  it('does not make a fresh run stale because of changes before it', () => {
    const events = [started(0), ...run(10, 1), disk(15, 'src/a.ts'), ...run(20, 0), ended(40)];
    const statuses = validationsOf(events).map((e) => (e.kind === 'validation' ? e.status : ''));
    // The earlier failure stays a failure; only the later pass is evaluated for staleness (and is fresh).
    expect(statuses).toEqual(['running', 'failed', 'running', 'passed']);
  });

  it('never hides a recorded failure behind later changes', () => {
    expect(validationsOf([started(0), ...run(10, 1), disk(30, 'src/a.ts')]).at(-1)).toMatchObject({ status: 'failed' });
  });

  it('turns a pass followed by a change into stale', () => {
    expect(validationsOf([started(0), ...run(10, 0), disk(30, 'src/a.ts')]).at(-1)).toMatchObject({ status: 'stale' });
  });

  it('leaves an unknown result and a running check as they are', () => {
    const events = [started(0), observed(9, 'u', 'build'), result(10, 'u'), observed(11, 'r', 'test'), disk(30, 'src/a.ts')];
    const last = Object.fromEntries(validationsOf(events).map((e) => (e.kind === 'validation' ? [e.validation, e.status] : ['', ''])));
    expect(last).toEqual({ build: 'unknown', tests: 'running' });
  });

  it('counts a change in another session of the same project', () => {
    const events = [started(0), ...run(10, 0), started(20, { sessionId: 's2' }), edit(21, 'src/b.ts', 'added', { sessionId: 's2' })];
    expect(validationsOf(events, 's1').at(-1)).toMatchObject({ status: 'stale' });
  });
});

describe('projectSession: validation history', () => {
  const run = (testAtSec: number, status: number) => [observed(testAtSec - 1, `t${testAtSec}`, 'test'), result(testAtSec, `t${testAtSec}`, status)];
  const statusLog = (events: readonly RaioEvent[]) => validationsOf(events).map((e) => (e.kind === 'validation' ? [e.atMs, e.status] : []));

  it('records a pass as passed when it happened and adds a later stale entry at the change time', () => {
    const events = [started(0), edit(1, 'src/auth/a.ts', 'added'), ...run(10, 0), disk(30, 'src/auth/a.ts'), ended(40)];
    expect(statusLog(events)).toEqual([
      [9000, 'running'],
      [10_000, 'passed'],
      [30_000, 'stale'],
    ]);
  });

  it('keeps the stale entry in time order relative to later log entries', () => {
    const events = [started(0), ...run(10, 0), disk(12, 'src/a.ts'), observed(15, 'again', 'test'), ended(40)];
    expect(statusLog(events)).toEqual([
      [9000, 'running'],
      [10_000, 'passed'],
      [12_000, 'stale'],
      [15_000, 'running'],
    ]);
    const log = eventsOf(events);
    expect(log.map((e) => e.atMs)).toEqual([...log.map((e) => e.atMs)].sort((a, b) => a - b));
    expect(log.at(-1)?.kind).toBe('session.end');
  });

  it('keeps the validation insight history: passed first, then stale with when the code changed', () => {
    const { insights } = detailed([started(0), ...run(10, 0), disk(30, 'src/a.ts'), ended(40)]);
    expect(insights.validations.map((v) => v.status)).toEqual(['running', 'passed', 'stale']);
    expect(insights.validations[1]).toMatchObject({ status: 'passed', recordedStatus: 'passed', atMs: 10_000 });
    expect(insights.validations[1]).not.toHaveProperty('staleSinceMs');
    expect(insights.validations[2]).toMatchObject({ status: 'stale', recordedStatus: 'passed', atMs: 30_000, staleSinceMs: 30_000 });
  });

  it('still ends a pass-then-change run as stale in the replay and never as passed', () => {
    const { snapshot } = detailed([started(0), ...run(10, 0), disk(30, 'src/a.ts'), ended(40)]);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.validations.map((v) => v.status)).toEqual(['stale']);
    expect(script.summary.checks).toBe('unverified');
    expect(deriveInsights(snapshot.log).validations.get('tests')).toBe('stale');
  });

  it('places a stale entry for a change after the session at the last session event, never after session.end', () => {
    const { snapshot, insights } = detailed([started(0), ...run(10, 0), ended(40), disk(100, 'src/a.ts')]);
    expect(snapshot.log.events.at(-1)).toMatchObject({ kind: 'session.end', atMs: 40_000 });
    const stale = snapshot.log.events.find((e) => e.kind === 'validation' && e.status === 'stale');
    expect(stale).toMatchObject({ atMs: 40_000 });
    expect(insights.validations.at(-1)).toMatchObject({ status: 'stale', staleSinceMs: 100_000 });
  });

  it('keeps a failure failed after a later edit, with no stale entry and a code-changed annotation', () => {
    const events = [started(0), ...run(10, 1), disk(30, 'src/a.ts'), ended(40)];
    expect(statusLog(events)).toEqual([
      [9000, 'running'],
      [10_000, 'failed'],
    ]);
    const { insights } = detailed(events);
    expect(insights.validations.map((v) => v.status)).toEqual(['running', 'failed']);
    expect(insights.validations.at(-1)).toMatchObject({ status: 'failed', recordedStatus: 'failed', atMs: 10_000, codeChangedSinceMs: 30_000 });
    expect(insights.validations.at(-1)).not.toHaveProperty('staleSinceMs');
  });

  it('counts a later reported edit as a code change for a failure too', () => {
    const { insights } = detailed([started(0), ...run(10, 2), edit(20, 'src/a.ts', 'modified'), ended(40)]);
    expect(insights.validations.at(-1)).toMatchObject({ status: 'failed', codeChangedSinceMs: 20_000 });
  });

  it('still shows the failure in the replay end state when code changed afterwards', () => {
    const { snapshot } = detailed([started(0), ...run(10, 1), disk(30, 'src/a.ts'), ended(40)]);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.validations.map((v) => v.status)).toEqual(['failed']);
    expect(script.summary.checks).toBe('some-failed');
    expect(script.status.at(-1)?.state).toBe('failed');
    expect(deriveInsights(snapshot.log).validations.get('tests')).toBe('failed');
  });

  it('leaves a failure without a later change unannotated', () => {
    const { insights } = detailed([started(0), ...run(10, 1), ended(40)]);
    expect(insights.validations.at(-1)).not.toHaveProperty('codeChangedSinceMs');
  });

  it('does not annotate a failure with the echo of an edit reported before it', () => {
    const { insights } = detailed([started(0), edit(9, 'src/a.ts', 'modified'), ...run(10, 1), disk(11, 'src/a.ts'), ended(40)]);
    expect(insights.validations.at(-1)).not.toHaveProperty('codeChangedSinceMs');
  });
});

describe('projectSession: notices', () => {
  const risks = (events: readonly RaioEvent[]) => eventsOf(events).filter((e) => e.kind === 'risk');

  it('raises factual notices for migration, dependency and config files with the path only', () => {
    const found = risks([
      started(0),
      edit(1, 'db/migrations/0001_init.sql', 'added'),
      edit(2, 'package.json', 'modified'),
      edit(3, 'Cargo.lock', 'modified'),
      edit(4, '.env.local', 'added'),
      edit(5, 'vite.config.ts', 'modified'),
      edit(6, 'src/auth/plain.ts', 'added'),
    ]);
    expect(found.map((r) => (r.kind === 'risk' ? [r.risk, r.detail] : []))).toEqual([
      ['migration', 'db/migrations/0001_init.sql'],
      ['dependency', 'package.json'],
      ['dependency', 'Cargo.lock'],
      ['config', '.env.local'],
      ['config', 'vite.config.ts'],
    ]);
  });

  it('attaches the notice to the group of the file and follows the write at the same time', () => {
    const events = eventsOf([started(0), edit(1, 'db/migrations/0001_init.sql', 'added')]);
    expect(events[1]).toMatchObject({ kind: 'file.write', nodeId: 'db' });
    expect(events[2]).toEqual({ kind: 'risk', atMs: 1000, nodeId: 'db', risk: 'migration', detail: 'db/migrations/0001_init.sql' });
  });

  it('reports a path once even if it is edited again', () => {
    expect(risks([started(0), edit(1, 'package.json'), edit(2, 'package.json')])).toHaveLength(1);
  });

  it('does not raise notices from reads', () => {
    expect(risks([started(0), read(1, 'package.json'), read(2, '.env')])).toEqual([]);
  });

  it('shows a notice for an unassigned disk change only in the insights, not as an agent notice', () => {
    const { insights, snapshot } = detailed([started(0), edit(1, 'src/auth/a.ts'), disk(20, 'package.json'), ended(30)]);
    expect(insights.unassigned).toMatchObject([{ path: 'package.json', notice: 'dependency' }]);
    expect(snapshot.log.events.some((e) => e.kind === 'risk')).toBe(false);
  });
});

describe('projectSession: parallel activity', () => {
  const sub = (id: string) => ({ subagentId: id });

  it('is false for a single actor', () => {
    expect(detailed([started(0), edit(1, 'src/a.ts'), edit(2, 'src/b.ts')]).insights).toMatchObject({ parallel: false, actors: 1 });
  });

  it('is true when two subagents interleave', () => {
    const events = [started(0), edit(1, 'src/a.ts', 'added', sub('x')), edit(2, 'src/b.ts', 'added', sub('y')), edit(3, 'src/c.ts', 'added', sub('x')), edit(4, 'src/d.ts', 'added', sub('y'))];
    expect(detailed(events).insights).toMatchObject({ parallel: true, actors: 2 });
  });

  it('is true when the main agent and a subagent interleave', () => {
    const events = [started(0), edit(1, 'src/a.ts'), edit(2, 'src/b.ts', 'added', sub('x')), edit(3, 'src/c.ts'), edit(4, 'src/d.ts', 'added', sub('x'))];
    expect(detailed(events).insights.parallel).toBe(true);
  });

  it('is false for subagents that ran one after another', () => {
    const events = [started(0), edit(1, 'src/a.ts', 'added', sub('x')), edit(2, 'src/b.ts', 'added', sub('x')), edit(3, 'src/c.ts', 'added', sub('y')), edit(4, 'src/d.ts', 'added', sub('y'))];
    expect(detailed(events).insights.parallel).toBe(false);
  });

  it('does not count the session start or end as an actor', () => {
    expect(detailed([started(0), edit(2, 'src/a.ts', 'added', sub('x')), ended(5)]).insights).toMatchObject({ parallel: false, actors: 1 });
  });

  it('does not invent a causal chain: the log has no edges and the story has no dependency wording', () => {
    const events = [started(0), edit(1, 'src/auth/a.ts', 'added', sub('x')), edit(2, 'src/api/b.ts', 'added', sub('y')), edit(3, 'src/auth/c.ts', 'added', sub('x')), ended(9)];
    const snapshot = project(events);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.edges).toEqual([]);
    expect(script.story.map((s) => s.label).join('\n')).not.toMatch(/\b(calls?|connected|depends?|now uses)\b/i);
  });
});

/**
 * Hand conversion of the sanitised Claude Code 2.1.286 hook payloads (.local/fixtures/claude-code-2.1.286,
 * mirrored under src-tauri/tests/fixtures) into the RaioEvent v1 records the core produces. Paths are
 * project-relative; prompts, file contents, tool responses and command lines never appear, which is the point.
 */
describe('projectSession: Claude Code 2.1.286 fixture session', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const claude = { sessionId };
  const events: RaioEvent[] = [
    ev('session.started', 0, [], { detail: 'startup' }, claude), // 01 SessionStart
    ev('file.inspected', 1, ['src/auth/session.ts'], { toolUseId: 'toolu_fixture_01', toolName: 'Read' }, claude), // 03/04 Read
    ev('file.edit.reported', 2, ['src/auth/login.ts'], { toolUseId: 'toolu_fixture_02', toolName: 'Write', change: 'added' }, claude), // 05/06 Write create
    ev('file.edit.reported', 3, ['db/migrations/0001_init.sql'], { toolUseId: 'toolu_fixture_03', toolName: 'Write', change: 'added' }, claude), // 07/08
    ev('file.edit.reported', 4, ['test/login.test.mjs'], { toolUseId: 'toolu_fixture_04', toolName: 'Write', change: 'added' }, claude), // 09/10
    ev('command.observed', 5, [], { toolUseId: 'toolu_fixture_05', toolName: 'Bash', commandClass: 'other', program: 'node' }, claude), // 11 denied compound command, no result
    ev('command.observed', 6, [], { toolUseId: 'toolu_fixture_06', toolName: 'Bash', commandClass: 'test', program: 'node' }, claude), // 12 node --test test/
    ev('command.result', 7, [], { toolUseId: 'toolu_fixture_06', toolName: 'Bash', exitCode: 1, exitCodeSource: 'failure-message' }, claude), // 13 PostToolUseFailure "Exit code 1"
    ev('command.observed', 8, [], { toolUseId: 'toolu_fixture_07', toolName: 'Bash', commandClass: 'other', program: 'node' }, claude), // 14 node -e "process.exit(3)"
    ev('command.result', 9, [], { toolUseId: 'toolu_fixture_07', toolName: 'Bash', exitCode: 3, exitCodeSource: 'failure-message' }, claude), // 15 "Exit code 3"
    ev('command.observed', 10, [], { toolUseId: 'toolu_fixture_08', toolName: 'Bash', commandClass: 'test', program: 'node' }, claude), // 16 node --test
    ev('command.result', 11, [], { toolUseId: 'toolu_fixture_08', toolName: 'Bash', exitCode: 0, exitCodeSource: 'tool-success' }, claude), // 17 PostToolUse
    ev('turn.ended', 12, [], {}, claude), // 18 Stop
    ev('session.ended', 13, [], { detail: 'other' }, claude), // 19 SessionEnd
  ];

  it('projects the whole session without leaking any sentinel text', () => {
    const projected = detailed(events);
    const script = compileReplay(projected.snapshot.log, projected.snapshot.graph);
    const everything = JSON.stringify({ snapshot: projected.snapshot, insights: projected.insights, script });
    expect(everything).not.toContain('SENTINEL_');
    expect(everything).not.toContain('C:\\\\fixture');
  });

  it('shows what the session factually did', () => {
    const { snapshot, insights } = detailed(events);
    expect(snapshot.log.id).toBe(sessionId);
    expect(snapshot.log.agent).toBe('claude');
    expect(snapshot.graph.nodes.map((n) => n.id).sort()).toEqual(['auth', 'db', 'tests']);
    expect(snapshot.graph.edges).toEqual([]);
    const writes = snapshot.log.events.filter((e) => e.kind === 'file.write');
    expect(writes.map((e) => (e.kind === 'file.write' ? [e.path, e.change] : []))).toEqual([
      ['src/auth/login.ts', 'added'],
      ['db/migrations/0001_init.sql', 'added'],
      ['test/login.test.mjs', 'added'],
    ]);
    expect(snapshot.log.events.filter((e) => e.kind === 'risk')).toEqual([{ kind: 'risk', atMs: 3000, nodeId: 'db', risk: 'migration', detail: 'db/migrations/0001_init.sql' }]);
    const final = insights.validations.filter((v) => v.kind === 'tests').at(-1);
    expect(final).toMatchObject({ status: 'passed', recordedStatus: 'passed' });
    expect(insights.validations.some((v) => v.recordedStatus === 'failed')).toBe(true);
    expect(insights.parallel).toBe(false);
    // The watcher was not running in this capture: edits stay "reported", never "consistent".
    expect(insights.reportedEdits.every((e) => e.disk === 'not-observed')).toBe(true);
  });

  it('keeps the compound command that never reported a result out of the checks', () => {
    expect(validationsOf(events).length).toBe(4);
  });

  it('compiles a completed replay within the budget', () => {
    const { snapshot } = detailed(events);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.status.at(-1)?.state).toBe('complete');
    expect(script.duration).toBeLessThanOrEqual(10.05);
  });
});

describe('projectSession: static import edges', () => {
  const scanOf = (files: Record<string, string[]>, extra: Partial<ProjectImports> = {}): ProjectImports => ({
    files: Object.entries(files).map(([path, specifiers]) => ({ path, specifiers })),
    truncated: false,
    skipped: 0,
    scannedAtMs: 1,
    ...extra,
  });
  const withImports = (events: readonly RaioEvent[], imports: ProjectImports | null | undefined) => {
    const projected = projectSessionDetailed(PROJECT, events, undefined, imports);
    if (!projected) throw new Error('expected a projection');
    return projected;
  };
  const SESSION = [started(0), edit(1, 'src/web/app.ts'), edit(2, 'src/api/users.ts'), read(3, 'src/auth/session.ts')];
  const FILES = { 'src/web/app.ts': ['../api/users', 'react'], 'src/api/users.ts': ['../auth/session'], 'src/auth/session.ts': [] };

  it('puts the derived import edges between the touched groups on the map and says so (heuristic)', () => {
    const { snapshot, insights } = withImports(SESSION, scanOf(FILES));
    expect(snapshot.graph.edges.map((e) => e.id).sort()).toEqual(['api->auth', 'web->api']);
    expect(insights.relationships).toEqual({ kind: 'static-imports', edges: 2, imports: 2, unresolved: 1, truncated: false, skipped: 0 });
    expect(insights.note).toContain('Relationships: static imports between areas (heuristic)');
    expect(insights.note).toMatch(/1 import specifier was not resolved/);
  });

  it('draws one line for areas that import each other, directed from the heavier side, and counts it once', () => {
    const { snapshot, insights } = withImports(SESSION, scanOf({ 'src/web/app.ts': ['../api/users'], 'src/api/users.ts': ['../web/app', '../web/app.ts'], 'src/auth/session.ts': [] }));
    expect(snapshot.graph.edges.map((e) => e.id)).toEqual(['api->web']);
    expect(insights.relationships).toMatchObject({ kind: 'static-imports', edges: 1, imports: 3 });
  });

  it('says the relationships are as of the last scan when a later rescan failed', () => {
    const projected = projectSessionDetailed(PROJECT, SESSION, undefined, scanOf(FILES), true)!;
    expect(projected.insights.relationships).toMatchObject({ kind: 'static-imports', stale: true });
    expect(projected.insights.note).toMatch(/as of the last scan/);
    expect(projected.snapshot.graph.edges).toHaveLength(2);
    expect(withImports(SESSION, scanOf(FILES)).insights.note).not.toMatch(/last scan/);
    expect(projectSessionDetailed(PROJECT, SESSION, undefined, null, true)!.insights.relationships).toBe('unknown');
  });

  it('keeps "relationships unknown" with no scan, a failed scan or no TS/JS files, and creates no edge', () => {
    for (const imports of [undefined, null, scanOf({})]) {
      const { snapshot, insights } = withImports(SESSION, imports);
      expect(snapshot.graph.edges).toEqual([]);
      expect(insights.relationships).toBe('unknown');
      expect(insights.note).toBe(HEURISTIC_NOTE);
    }
  });

  it('ignores imports of areas the session never touched and files outside the map', () => {
    const { snapshot, insights } = withImports(SESSION, scanOf({ 'src/web/app.ts': ['../jobs/run'], 'src/jobs/run.ts': ['../web/app'], 'src/auth/session.ts': [] }));
    expect(snapshot.graph.edges).toEqual([]);
    expect(insights.relationships).toMatchObject({ kind: 'static-imports', edges: 0 });
    expect(insights.relationships).toMatchObject({ unresolved: 0 });
  });

  it('flags a partial scan in the copy and never lets activity order create an edge', () => {
    const { snapshot, insights } = withImports(SESSION, scanOf({ 'src/web/app.ts': [], 'src/api/users.ts': [] }, { truncated: true }));
    expect(snapshot.graph.edges).toEqual([]);
    expect(insights.note).toMatch(/partial/i);
  });

  it('points imports of merged groups at Other', () => {
    const edits = Array.from({ length: 15 }, (_, i) => edit(i + 1, `dir${String(i).padStart(2, '0')}/f.ts`, 'added'));
    const { snapshot } = withImports([started(0), ...edits], scanOf({ 'dir14/f.ts': ['../dir00/f'], 'dir13/f.ts': ['../dir14/f'], 'dir00/f.ts': [] }));
    expect(snapshot.graph.edges.map((e) => e.id)).toEqual(['merged-other->dir00']);
  });

  it('lets the replay travel an edge only when the imports created it', () => {
    const edges = (imports: ProjectImports) => {
      const { snapshot } = withImports([started(0), edit(1, 'src/web/app.ts'), edit(2, 'src/api/users.ts')], imports);
      return compileReplay(snapshot.log, snapshot.graph).edges.map((c) => c.edgeId);
    };
    expect(edges(scanOf({ 'src/web/app.ts': ['../api/users'], 'src/api/users.ts': [] }))).toEqual(['web->api']);
    expect(edges(scanOf({ 'src/web/app.ts': [], 'src/api/users.ts': [] }))).toEqual([]);
    expect(edges(scanOf({}))).toEqual([]);
  });

  it('is deterministic for the same events and scan', () => {
    const a = withImports(SESSION, scanOf(FILES));
    const b = withImports(SESSION, scanOf(FILES));
    expect(b.snapshot.graph.edges.map((e) => [e.id, e.path.toSvg()])).toEqual(a.snapshot.graph.edges.map((e) => [e.id, e.path.toSvg()]));
  });
});
