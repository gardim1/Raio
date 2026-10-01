import { describe, expect, it } from 'vitest';
import { createGraph } from '../../architecture/model/graph';
import { demoGraph } from '../../architecture/model/demoProject';
import { canonicalScript } from './canonicalScript';
import { compileReplay, REPLAY_BUDGET_SECONDS } from './compileReplay';
import { demoSessionLog } from './demoSession';
import { RISK_LABEL, type AgentEvent, type SessionLog } from './events';

/**
 * Semantic corrections from docs/ARCHITECTURE.md: activity is never presented as an
 * architecture dependency, notices are factual, and validation claims need evidence.
 */

const log = (events: readonly AgentEvent[], overrides: Partial<SessionLog> = {}): SessionLog => ({ ...demoSessionLog, ...overrides, events });

const CAUSAL_WORDS = /\b(calls?|connected|depends?|now uses)\b/i;

describe('activity is not dependency', () => {
  it('never phrases replay activity as a call or connection between systems', () => {
    const replay = compileReplay(demoSessionLog, demoGraph);
    for (const ev of replay.story) expect(ev.label, ev.label).not.toMatch(CAUSAL_WORDS);
  });

  it('keeps the concept story factual as well', () => {
    for (const ev of canonicalScript.story) expect(ev.label, ev.label).not.toMatch(CAUSAL_WORDS);
  });

  it('claims "Inspecting" only where a read was observed', () => {
    const withoutReads = compileReplay(
      log([
        { kind: 'session.start', atMs: 0 },
        { kind: 'file.write', atMs: 1000, path: 'src/auth/a.ts', nodeId: 'auth', change: 'modified' },
        { kind: 'session.end', atMs: 3000, outcome: 'completed' },
      ]),
      demoGraph,
    );
    expect(withoutReads.story.map((e) => e.label)).toContain('Auth updated');
    expect(withoutReads.story.some((e) => e.label.startsWith('Inspecting'))).toBe(false);
    expect(compileReplay(demoSessionLog, demoGraph).story.map((e) => e.label)).toContain('Inspecting Auth');
  });

  it('only reveals edges that exist in the project map', () => {
    const replay = compileReplay(demoSessionLog, demoGraph);
    for (const cue of replay.edges) expect(demoGraph.edgeById.has(cue.edgeId), cue.edgeId).toBe(true);
  });

  it('reveals no edge when the map has no relationship between the touched systems', () => {
    const noEdges = createGraph([...demoGraph.nodes], []);
    const replay = compileReplay(demoSessionLog, noEdges);
    expect(replay.edges).toEqual([]);
    expect(replay.orb.some((s) => s.kind === 'edge')).toBe(false);
    expect(replay.nodes.map((n) => n.nodeId).sort()).toEqual(['api', 'auth', 'db', 'frontend']);
  });

  it('jumps to an unconnected system without flagging it out of scope automatically', () => {
    const script = compileReplay(
      log([
        { kind: 'session.start', atMs: 0 },
        { kind: 'file.write', atMs: 1000, path: 'src/auth/a.ts', nodeId: 'auth', change: 'modified' },
        { kind: 'file.write', atMs: 2000, path: 'infra/billing.ts', nodeId: 'payments', change: 'modified' },
        { kind: 'session.end', atMs: 3000, outcome: 'completed' },
      ]),
      demoGraph,
    );
    expect(script.nodes.map((n) => n.nodeId)).toEqual(['auth', 'payments']);
    expect(script.risks).toEqual([]);
  });

  it('shows out of scope only when the user marked the path (explicit risk event)', () => {
    const script = compileReplay(
      log([
        { kind: 'session.start', atMs: 0 },
        { kind: 'file.write', atMs: 1000, path: 'infra/billing.ts', nodeId: 'payments', change: 'modified' },
        { kind: 'risk', atMs: 1000, nodeId: 'payments', risk: 'outOfScope', detail: 'infra/ is marked out of scope for this task' },
        { kind: 'session.end', atMs: 3000, outcome: 'completed' },
      ]),
      demoGraph,
    );
    expect(script.risks.map((r) => r.kind)).toEqual(['outOfScope']);
  });
});

describe('factual notices', () => {
  it('describes what was observed, not what may have happened', () => {
    expect(RISK_LABEL.migration).toBe('Migration file added');
    expect(RISK_LABEL.dependency).toBe('Dependency manifest changed');
    expect(RISK_LABEL.config).toBe('Configuration file changed');
    expect(Object.keys(RISK_LABEL).sort()).toEqual(['config', 'dependency', 'migration', 'outOfScope']);
  });
});

describe('validation claims need evidence', () => {
  const base: AgentEvent[] = [
    { kind: 'session.start', atMs: 0 },
    { kind: 'file.write', atMs: 1000, path: 'src/auth/a.ts', nodeId: 'auth', change: 'modified' },
  ];

  it('says no checks ran when no validation was observed', () => {
    const script = compileReplay(log([...base, { kind: 'session.end', atMs: 5000, outcome: 'completed' }]), demoGraph);
    expect(script.validations).toEqual([]);
    expect(script.summary.checks).toBe('none-ran');
  });

  it('claims everything validated only when every observed check passed', () => {
    expect(compileReplay(demoSessionLog, demoGraph).summary.checks).toBe('all-passed');
    expect(canonicalScript.summary.checks).toBe('all-passed');
  });

  it('keeps a check without a captured result as unknown instead of dropping or passing it', () => {
    const script = compileReplay(
      log([...base, { kind: 'validation', atMs: 2000, validation: 'tests', status: 'unknown' }, { kind: 'session.end', atMs: 5000, outcome: 'completed' }]),
      demoGraph,
    );
    expect(script.validations.map((v) => v.status)).toEqual(['unknown']);
    expect(script.summary.checks).toBe('unverified');
    expect(script.story.some((e) => e.label === 'Tests: result unknown')).toBe(true);
  });

  it('turns a check still running at the end of the session into incomplete', () => {
    const script = compileReplay(
      log([...base, { kind: 'validation', atMs: 2000, validation: 'build', status: 'running' }, { kind: 'session.end', atMs: 5000, outcome: 'completed' }]),
      demoGraph,
    );
    expect(script.validations.map((v) => v.status)).toEqual(['incomplete']);
    expect(script.summary.checks).toBe('unverified');
  });

  it('marks a session without an end event as incomplete', () => {
    const script = compileReplay(log(base), demoGraph);
    expect(script.status.at(-1)!.state).toBe('incomplete');
  });

  it('never drops failures or warnings to fit the replay budget', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const nodes = ids.map((id, i) => ({ id, label: id.toUpperCase(), kind: 'other' as const, position: { x: 80 + (i % 6) * 160, y: i < 6 ? 150 : 380 } }));
    const graph = createGraph(nodes, []);
    const script = compileReplay(
      log([
        { kind: 'session.start', atMs: 0 },
        ...ids.map((id, i) => ({ kind: 'file.write' as const, atMs: (i + 1) * 60_000, path: `${id}/x.ts`, nodeId: id, change: 'modified' as const })),
        { kind: 'risk', atMs: 400_000, nodeId: 'n5', risk: 'migration', detail: 'adds a table' },
        { kind: 'validation', atMs: 900_000, validation: 'build', status: 'failed' },
        { kind: 'session.end', atMs: 1_000_000, outcome: 'completed' },
      ]),
      graph,
    );
    expect(script.duration).toBeLessThanOrEqual(REPLAY_BUDGET_SECONDS + 0.05);
    expect(script.story.some((e) => e.label === 'Build failed')).toBe(true);
    expect(script.risks.some((r) => r.kind === 'migration' && r.nodeId === 'n5')).toBe(true);
    expect(script.summary.checks).toBe('some-failed');
  });
});

describe('concept and live demo copy', () => {
  it('uses the factual risk labels in the canonical script', () => {
    for (const r of canonicalScript.risks) expect(r.label).toBe(RISK_LABEL[r.kind]);
  });
});
