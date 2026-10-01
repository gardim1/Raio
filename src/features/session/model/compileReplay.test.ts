import { describe, expect, it } from 'vitest';
import { createGraph } from '../../architecture/model/graph';
import { demoGraph } from '../../architecture/model/demoProject';
import { cubicFromSvg } from '../../../shared/geometry/cubicPath';
import { canonicalScript } from './canonicalScript';
import { compileReplay, REPLAY_BUDGET_SECONDS } from './compileReplay';
import { demoSessionLog } from './demoSession';
import type { SessionLog } from './events';
import { orbPosition } from './evaluateFrame';

const TOLERANCE = 0.06;

describe('compileReplay — semantic Session Replay', () => {
  const replay = compileReplay(demoSessionLog, demoGraph);

  it('reproduces the canonical choreography for the demo session', () => {
    for (const cue of canonicalScript.nodes) {
      const compiled = replay.nodes.find((n) => n.nodeId === cue.nodeId);
      expect(compiled, cue.nodeId).toBeDefined();
      expect(Math.abs(compiled!.activateAt - cue.activateAt), cue.nodeId).toBeLessThan(TOLERANCE);
    }
    for (const cue of canonicalScript.edges) {
      const compiled = replay.edges.find((e) => e.edgeId === cue.edgeId);
      expect(compiled, cue.edgeId).toBeDefined();
      expect(Math.abs(compiled!.revealAt - cue.revealAt), cue.edgeId).toBeLessThan(TOLERANCE);
    }
    expect(Math.abs(replay.risks[0]!.at - canonicalScript.risks[0]!.at)).toBeLessThan(TOLERANCE);
    expect(replay.validations.map((v) => v.kind)).toEqual(['build', 'tests']);
    replay.validations.forEach((v, i) => expect(Math.abs(v.at - canonicalScript.validations[i]!.at)).toBeLessThan(TOLERANCE));
    expect(Math.abs(replay.duration - canonicalScript.duration)).toBeLessThan(0.1);
  });

  it('reveals the existing Frontend → Auth map edge instead of flying Raio there', () => {
    const travelled = replay.orb.filter((s) => s.kind === 'edge').map((s) => (s.kind === 'edge' ? s.edgeId : ''));
    expect(travelled).toEqual(['auth-api', 'api-db']);
  });

  it('keeps Raio continuous', () => {
    let previous = orbPosition(replay, demoGraph, 0);
    for (let t = 1 / 60; t <= replay.duration + 1; t += 1 / 60) {
      const p = orbPosition(replay, demoGraph, t);
      expect(Math.hypot(p.x - previous.x, p.y - previous.y)).toBeLessThan(32);
      previous = p;
    }
  });

  it('summarizes affected systems and changes worth reviewing', () => {
    expect(replay.summary.systems).toBe(4);
    expect(replay.summary.reviewCount).toBe(1);
  });

  it('compresses a long, wide session into the replay budget in chronological order', () => {
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const nodes = ids.map((id, i) => ({ id, label: id.toUpperCase(), kind: 'other' as const, position: { x: 100 + i * 110, y: i % 2 ? 330 : 190 } }));
    const edges = ids.slice(1).map((id, i) => {
      const a = nodes[i]!.position;
      const b = nodes[i + 1]!.position;
      return { id: `${ids[i]}-${id}`, from: ids[i]!, to: id, path: cubicFromSvg(`M${a.x + 66},${a.y} C${a.x + 100},${a.y} ${b.x - 100},${b.y} ${b.x - 66},${b.y}`) };
    });
    const graph = createGraph(nodes, edges);
    const log: SessionLog = {
      id: 'long',
      agent: 'codex',
      task: 'Refactor billing pipeline',
      project: 'big',
      startedAt: '2026-10-01T10:00:00Z',
      events: [
        { kind: 'session.start', atMs: 0 },
        ...ids.flatMap((id, i) => [
          { kind: 'file.write' as const, atMs: (i + 1) * 300_000, path: `${id}/a.ts`, nodeId: id, change: 'modified' as const },
          { kind: 'file.write' as const, atMs: (i + 1) * 300_000 + 60_000, path: `${id}/a.ts`, nodeId: id, change: 'modified' as const },
        ]),
        { kind: 'risk', atMs: 1_000_000, nodeId: 'n3', risk: 'dependency', detail: 'Added stripe@18' },
        { kind: 'validation', atMs: 2_900_000, validation: 'tests', status: 'failed' },
        { kind: 'session.end', atMs: 3_000_000, outcome: 'completed' },
      ],
    };
    const script = compileReplay(log, graph);
    expect(script.duration).toBeLessThanOrEqual(REPLAY_BUDGET_SECONDS + 0.05);
    const order = [...script.nodes].sort((a, b) => a.activateAt - b.activateAt).map((n) => n.nodeId);
    expect(order).toEqual(ids);
    expect(script.status.at(-1)!.state).toBe('failed');
    expect(script.summary.reviewCount).toBe(2);
  });

  // Out-of-scope is no longer inferred from map topology; see semantics.test.ts.

});
