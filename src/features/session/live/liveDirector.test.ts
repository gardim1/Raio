import { describe, expect, it } from 'vitest';
import { demoGraph } from '../../architecture/model/demoProject';
import { createGraph } from '../../architecture/model/graph';
import { compileReplay } from '../model/compileReplay';
import { evaluateFrame } from '../model/evaluateFrame';
import type { AgentEvent, SessionLog } from '../model/events';
import type { ChoreographyScript } from '../model/script';
import {
  isSettled,
  LAG_TARGET_SECONDS,
  type LiveState,
  protectedTimes,
  RATE_MAX,
  retargetLive,
  settledAt,
  startLive,
  stepLive,
} from './liveDirector';
import { simulateLive } from './simulateLive';

/** The map the live product has today: nodes only, relationships unknown. */
const graph = createGraph(demoGraph.nodes, []);
const FRAME = 1000 / 60;

const write = (atMs: number, nodeId: string): AgentEvent => ({ kind: 'file.write', atMs, path: `${nodeId}/file-${atMs}.ts`, nodeId, change: 'modified' });
const risk = (atMs: number, nodeId: string): AgentEvent => ({ kind: 'risk', atMs, nodeId, risk: 'migration', detail: 'x' });
const log = (events: AgentEvent[]): SessionLog => ({
  id: 'live-test',
  agent: 'claude',
  task: 'Live test',
  project: 'acme-web',
  startedAt: '2026-10-01T14:02:00Z',
  events: [{ kind: 'session.start', atMs: 0 }, ...events],
});
const live = (events: AgentEvent[]): ChoreographyScript => compileReplay(log(events), graph, { live: true });
const NODES = ['auth', 'frontend', 'api', 'db'] as const;
/** n writes alternating over four nodes, so every event is a new stop. */
const burst = (n: number, from = 1000): AgentEvent[] => Array.from({ length: n }, (_, i) => write(from + i * 10, NODES[i % NODES.length]!));

const CTX = { visible: true, reducedMotion: false } as const;

/** Runs the director at 60 fps from its own last update and returns every playhead step. */
const run = (state: LiveState, seconds: number, ctx = CTX): { state: LiveState; steps: { from: number; to: number; ms: number }[] } => {
  const steps: { from: number; to: number; ms: number }[] = [];
  let s = state;
  const start = state.wallMs;
  for (let ms = start + FRAME; ms <= start + seconds * 1000 + 1e-6; ms += FRAME) {
    const next = stepLive(s, ms, ctx);
    steps.push({ from: s.t, to: next.t, ms });
    s = next;
  }
  return { state: s, steps };
};

describe('compileReplay { live: true } — the same beats, in event order', () => {
  it('follows events in order, revisits included, merging consecutive writes to one system', () => {
    const script = live([write(1000, 'auth'), write(1100, 'auth'), write(2000, 'frontend'), write(3000, 'auth'), write(4000, 'api')]);
    expect(script.live?.visits.map((v) => v.nodeId)).toEqual(['auth', 'frontend', 'auth', 'api']);
    // One activation cue per system: a revisit never restarts the node's activation.
    expect(script.nodes.map((n) => n.nodeId).sort()).toEqual(['api', 'auth', 'frontend']);
    expect(script.nodes.find((n) => n.nodeId === 'auth')).not.toHaveProperty('retouchAt');
  });

  it('has no tail until the session ends: still working, no summary, parked and floating', () => {
    const script = live([write(1000, 'auth'), write(2000, 'frontend')]);
    expect(script.live?.open).toBe(true);
    expect(script.status.at(-1)?.state).toBe('working');
    expect(script.summary.at).toBe(Infinity);
    const last = script.orb.at(-1)!;
    expect(last.kind).toBe('hover');
    expect(last.t1).toBe(Infinity);
    const frame = evaluateFrame(script, graph, script.live!.eventsEndAt + 30);
    expect(frame.ui.status).toBe('working');
    expect(frame.ui.summaryVisible).toBe(false);
    expect(frame.ui.finished).toBe(false);
  });

  it('adds the tail when the session ended, with the same prefix', () => {
    const open = live([write(1000, 'auth'), write(2000, 'frontend')]);
    const ended = live([write(1000, 'auth'), write(2000, 'frontend'), { kind: 'session.end', atMs: 3000, outcome: 'completed' }]);
    expect(ended.live?.open).toBe(false);
    expect(ended.live?.eventsEndAt).toBeCloseTo(open.live!.eventsEndAt, 6);
    expect(ended.status.at(-1)?.state).toBe('complete');
    expect(Number.isFinite(ended.duration)).toBe(true);
    for (const [i, seg] of open.orb.slice(0, -1).entries()) expect(ended.orb[i]).toMatchObject({ kind: seg.kind, t0: seg.t0 });
  });

  it('never invents edges: no edge segment, cue or pulse on a map without relationships', () => {
    const script = live([...burst(8)]);
    expect(script.orb.filter((s) => s.kind === 'edge')).toEqual([]);
    expect(script.edges).toEqual([]);
    expect(script.pulses).toEqual([]);
  });

  it('keeps a running check running (not "incomplete") while the session is open', () => {
    const script = live([write(1000, 'auth'), { kind: 'validation', atMs: 2000, validation: 'tests', status: 'running' }]);
    expect(script.validations.map((v) => v.status)).toEqual(['running']);
  });

  it('turns a notice on the current system into its own stop, without travelling', () => {
    const script = live([write(1000, 'db'), risk(1500, 'db')]);
    expect(script.live?.visits.map((v) => v.nodeId)).toEqual(['db', 'db']);
    expect(script.risks).toHaveLength(1);
    expect(script.orb.filter((s) => s.kind === 'arc')).toHaveLength(1); // only the approach
  });

  it('leaves the replay compiler untouched when `live` is not requested', () => {
    const events = [write(1000, 'auth'), write(2000, 'frontend'), write(3000, 'auth'), { kind: 'session.end', atMs: 4000, outcome: 'completed' } as const];
    const replay = compileReplay(log(events), graph);
    expect(replay.live).toBeUndefined();
    expect(replay.nodes.map((n) => n.nodeId)).toEqual(['auth', 'frontend']); // first touch, one stop per system
  });
});

describe('live compile on a map that models edges (ready, not used by live data yet)', () => {
  const withEdges = compileReplay(
    log([write(1000, 'frontend'), write(2000, 'auth'), write(3000, 'api'), write(4000, 'auth'), write(5000, 'api'), write(6000, 'db')]),
    demoGraph,
    { live: true },
  );

  it('reveals each existing edge once, even when it is travelled again', () => {
    const ids = withEdges.edges.map((e) => e.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(withEdges.orb.some((s) => s.kind === 'edge')).toBe(true);
  });

  it('keeps Raio continuous while it revisits systems', () => {
    let previous = evaluateFrame(withEdges, demoGraph, 0).orb.position;
    for (let t = 1 / 60; t <= withEdges.live!.eventsEndAt + 2; t += 1 / 60) {
      const p = evaluateFrame(withEdges, demoGraph, t).orb.position;
      expect(Math.hypot(p.x - previous.x, p.y - previous.y), `t=${t.toFixed(2)}`).toBeLessThan(32);
      previous = p;
    }
  });
});

describe('live director — pacing', () => {
  it('plays a single new event at natural speed (rate 1)', () => {
    const a = live([write(1000, 'auth')]);
    const b = live([write(1000, 'auth'), write(9000, 'frontend')]);
    let s = startLive(a, 0);
    s = retargetLive(s, b, 0);
    const { state, steps } = run(s, 0.5);
    const advanced = state.t - s.t;
    expect(advanced).toBeGreaterThan(0.49);
    expect(advanced).toBeLessThan(0.51);
    expect(steps.every((x) => x.to >= x.from)).toBe(true);
  });

  it('starts a fresh session from the beginning so the viewer sees Raio wake', () => {
    const s = startLive(live([]), 0);
    expect(s.t).toBe(0);
  });

  it('jumps to the latest state the first time it sees a session already under way', () => {
    const script = live(burst(4));
    expect(startLive(script, 0).t).toBeCloseTo(settledAt(script), 6);
  });

  it('bounds the delay: a burst is time-compressed so the view reaches the latest event within ~2 s', () => {
    const before = live(burst(1));
    let s = startLive(before, 0);
    s = run(s, 1).state; // idle, parked
    const after = live(burst(4)); // three new stops at once
    const wall = s.wallMs;
    s = retargetLive(s, after, wall);
    const compressedRate = s.rate;
    const horizon = after.live!.eventsEndAt;
    expect((horizon - s.t) / s.rate).toBeLessThanOrEqual(LAG_TARGET_SECONDS + 1e-9);
    // Observe it: real seconds until the playhead reaches the new horizon.
    let seconds = 0;
    while (s.t < horizon - 1e-6 && seconds < 10) {
      s = stepLive(s, wall + (seconds += FRAME / 1000) * 1000, CTX);
    }
    expect(seconds).toBeLessThanOrEqual(LAG_TARGET_SECONDS + 0.05);
    expect(compressedRate).toBeGreaterThan(1);
  });

  it('never exceeds the maximum compression, and skips only surplus when that is not enough', () => {
    const before = live(burst(1));
    let s = run(startLive(before, 0), 1).state;
    const huge = live(burst(13)); // far more than 2 s × RATE_MAX of content
    s = retargetLive(s, huge, s.wallMs);
    expect(s.rate).toBeLessThanOrEqual(RATE_MAX);
    expect(huge.live!.eventsEndAt - s.t).toBeLessThanOrEqual(RATE_MAX * LAG_TARGET_SECONDS + 1e-9);
    expect((huge.live!.eventsEndAt - s.t) / s.rate).toBeLessThanOrEqual(LAG_TARGET_SECONDS + 1e-9);
  });

  it('holds still-new content to a rate of 1 once caught up', () => {
    const script = live(burst(2));
    let s = startLive(script, 0);
    s = { ...s, t: script.live!.eventsEndAt - 0.2, rate: 1 };
    const { state } = run(s, 1);
    expect(state.t - (script.live!.eventsEndAt - 0.2)).toBeCloseTo(1, 1);
  });
});

describe('live director — failures and notices are never skipped', () => {
  const events = (): AgentEvent[] => [
    ...burst(3),
    risk(1100, 'db'), // a warning stop in the middle of the burst
    ...burst(6, 1200),
    { kind: 'validation', atMs: 1300, validation: 'tests', status: 'failed' },
    ...burst(4, 1400),
  ];

  it('lists notices, failed/stale/unknown/incomplete checks as protected, not passed ones', () => {
    const script = live([...events(), { kind: 'validation', atMs: 1500, validation: 'build', status: 'passed' }]);
    const times = protectedTimes(script);
    expect(times).toContain(script.risks[0]!.at);
    const failed = script.validations.find((v) => v.status === 'failed')!;
    expect(times).toContain(failed.at);
    const passed = script.validations.find((v) => v.status === 'passed')!;
    expect(times).not.toContain(passed.at);
  });

  it('plays every protected moment on screen, even when a huge burst needs compression', () => {
    const base = live([write(500, 'auth')]);
    let s = run(startLive(base, 0), 1).state;
    const script = live(events());
    s = retargetLive(s, script, s.wallMs);
    const protectedAt = protectedTimes(script).filter((c) => c > s.t);
    const { steps } = run(s, 40);
    const maxStep = RATE_MAX * (FRAME / 1000) + 1e-9;
    for (const c of protectedAt) {
      const crossing = steps.find((x) => x.from < c && x.to >= c);
      expect(crossing, `protected moment at ${c.toFixed(2)}s was never played`).toBeDefined();
      expect(crossing!.to - crossing!.from).toBeLessThanOrEqual(maxStep);
    }
  });

  it('lets a burst arrive with a warning at the very front without losing it', () => {
    const base = live([write(500, 'auth')]);
    let s = run(startLive(base, 0), 1).state;
    // New content starts from where the orb is parked (the last stop's ready time), before catching up.
    const before = base.live!.visits.at(-1)!.readyAt;
    const script = live([write(500, 'auth'), write(600, 'frontend'), risk(650, 'frontend'), ...burst(10, 700)]);
    s = retargetLive(s, script, s.wallMs);
    // Whatever is protected and lies ahead of the playhead before catching up must still be ahead afterwards.
    const ahead = protectedTimes(script).filter((c) => c > before);
    expect(ahead.length).toBeGreaterThan(0);
    for (const c of ahead) expect(s.t).toBeLessThanOrEqual(c);
  });

  it('shows a failed check as soon as the log has it', () => {
    const script = live([write(500, 'auth'), { kind: 'validation', atMs: 800, validation: 'build', status: 'failed' }]);
    const frame = evaluateFrame(script, graph, settledAt(script));
    expect(frame.ui.validations.map((v) => v.status)).toEqual(['failed']);
  });
});

describe('live director — the map changes but the session does not', () => {
  const noEdges = createGraph(demoGraph.nodes, []);
  const events = [write(1000, 'frontend'), write(2000, 'auth'), write(3000, 'api'), write(4000, 'db')];
  const plain = compileReplay(log(events), noEdges, { live: true });
  const linked = compileReplay(log(events), demoGraph, { live: true });
  /** The orb segment that is playing at `t`. */
  const segmentAt = (script: ChoreographyScript, t: number) => script.orb.find((seg) => t >= seg.t0 && t < seg.t1);
  /** Index of the stop the playhead is at or past. */
  const visitAt = (script: ChoreographyScript, t: number) => script.live!.visits.reduce((index, v, i) => (t >= v.arrivalAt ? i : index), -1);

  it('has scripts that differ only by the edges (same stops, different motion)', () => {
    expect(linked.live!.visits.map((v) => v.nodeId)).toEqual(plain.live!.visits.map((v) => v.nodeId));
    expect(plain.orb.some((seg) => seg.kind === 'edge')).toBe(false);
    expect(linked.orb.some((seg) => seg.kind === 'edge')).toBe(true);
    expect(linked.live!.eventsEndAt).not.toBeCloseTo(plain.live!.eventsEndAt, 3);
  });

  it('does not replay motion for a parked session when edges appear', () => {
    let s = run(startLive(plain, 0), 1).state; // parked, still blinking
    const before = s.t;
    s = retargetLive(s, linked, s.wallMs);
    expect(s.t).toBeGreaterThanOrEqual(before);
    expect(s.t).toBeGreaterThanOrEqual(linked.live!.visits.at(-1)!.readyAt);
    expect(segmentAt(linked, s.t)?.kind).toBe('hover');
    const { steps } = run(s, 12);
    expect(steps.every((x) => x.to >= x.from)).toBe(true);
    expect(steps.every((x) => segmentAt(linked, x.to)?.kind === 'hover')).toBe(true);
  });

  it('keeps a session that had already come to rest at rest', () => {
    let s = run(startLive(plain, 0), 120).state;
    expect(isSettled(s, false)).toBe(true);
    s = retargetLive(s, linked, s.wallMs);
    expect(isSettled(s, false)).toBe(true);
  });

  it('does not rewind when the same log is recompiled with and then without edges', () => {
    let s = run(startLive(linked, 0), 120).state;
    const before = s.t;
    s = retargetLive(s, plain, s.wallMs);
    expect(s.t).toBeGreaterThanOrEqual(Math.min(before, plain.live!.quietAt));
    expect(isSettled(s, false)).toBe(true);
  });

  it('keeps the place inside the same stop when edges appear or go (the first stop has a dwell)', () => {
    for (const [from, to] of [[plain, linked], [linked, plain]] as const) {
      const stop = from.live!.visits[0]!;
      const start = { ...startLive(from, 0), t: stop.arrivalAt + 0.2, rate: 1 };
      const next = retargetLive(start, to, start.wallMs);
      const target = to.live!.visits[0]!;
      expect(next.t).toBeCloseTo(Math.min(target.arrivalAt + 0.2, target.readyAt), 6);
      expect(visitAt(to, next.t)).toBe(0);
      expect(run(next, 6).steps.every((x) => x.to >= x.from)).toBe(true);
    }
  });

  it('does not jump forward when the script gets shorter (an edge is removed: travel becomes a jump)', () => {
    for (const index of [1, 2, 3]) {
      const stop = linked.live!.visits[index]!;
      const start = { ...startLive(linked, 0), t: stop.arrivalAt + 0.1, rate: 1 };
      const next = retargetLive(start, plain, start.wallMs);
      const target = plain.live!.visits[index]!;
      expect(next.t, `stop ${index}`).toBeGreaterThanOrEqual(target.arrivalAt - 1e-9);
      expect(next.t, `stop ${index}`).toBeLessThanOrEqual(target.readyAt + 1e-9);
      expect(next.t, `stop ${index}`).toBeCloseTo(Math.min(target.arrivalAt + 0.1, target.readyAt), 6);
      expect(visitAt(plain, next.t)).toBe(index);
    }
  });

  it('keeps a stop at its end when the offset is longer than the new stop (clamped to the stop)', () => {
    const stop = linked.live!.visits[1]!;
    const late = { ...startLive(linked, 0), t: stop.readyAt - 0.001, rate: 1 };
    const next = retargetLive(late, plain, late.wallMs);
    const target = plain.live!.visits[1]!;
    expect(next.t).toBeLessThanOrEqual(target.readyAt + 1e-9);
    expect(next.t).toBeGreaterThanOrEqual(target.arrivalAt - 1e-9);
  });

  it('keeps the time left before the next arrival when the orb is between two stops', () => {
    for (const [from, to] of [[linked, plain], [plain, linked]] as const) {
      const was = from.live!.visits;
      const now = to.live!.visits;
      const between = (was[1]!.readyAt + was[2]!.arrivalAt) / 2;
      const start = { ...startLive(from, 0), t: between, rate: 1 };
      const next = retargetLive(start, to, start.wallMs);
      expect(next.t).toBeGreaterThanOrEqual(now[1]!.readyAt - 1e-9);
      expect(next.t).toBeLessThanOrEqual(now[2]!.arrivalAt + 1e-9);
      // The playhead never lands past the next stop's arrival, so nothing that has not been reached is skipped.
      expect(visitAt(to, next.t)).toBe(1);
    }
  });

  it('leaves a playhead before the first stop alone', () => {
    const start = { ...startLive(plain, 0), t: 0.3, rate: 1 };
    expect(retargetLive(start, linked, start.wallMs).t).toBeCloseTo(0.3, 6);
  });

  it('does not rewind an ended session that had already settled', () => {
    const end = { kind: 'session.end', atMs: 5000, outcome: 'completed' } as const;
    const endedPlain = compileReplay(log([...events, end]), noEdges, { live: true });
    const endedLinked = compileReplay(log([...events, end]), demoGraph, { live: true });
    let s = startLive(endedPlain, 0);
    expect(isSettled(s, false)).toBe(true);
    s = retargetLive(s, endedLinked, s.wallMs);
    expect(isSettled(s, false)).toBe(true);
    expect(s.t).toBeGreaterThanOrEqual(settledAt(endedLinked) - 1e-9);
  });

  it('still treats a different number of stops as new content (not a map change)', () => {
    const more = compileReplay(log([...events, write(5000, 'payments')]), demoGraph, { live: true });
    let s = run(startLive(plain, 0), 3).state;
    s = retargetLive(s, more, s.wallMs);
    expect(s.t).toBeLessThan(settledAt(more));
  });
});

describe('live director — hidden, reduced motion, session end', () => {
  it('does not advance while hidden and jumps to the latest state on show (no backlog replay)', () => {
    let script = live([write(1000, 'auth')]);
    let s = run(startLive(script, 0), 1).state;
    let wall = s.wallMs;
    s = stepLive(s, (wall += 16), { visible: false, reducedMotion: false });
    const hiddenFrom = s.t;
    for (let i = 0; i < 20; i++) {
      script = live(burst(2 + i));
      s = retargetLive(s, script, (wall += 500));
      s = stepLive(s, wall, { visible: false, reducedMotion: false });
      expect(s.t).toBeLessThanOrEqual(script.live!.eventsEndAt);
    }
    expect(s.t).toBeLessThanOrEqual(hiddenFrom + 1e-9); // nothing animated or skipped while hidden (a retarget may only rewind)
    const shown = stepLive(s, wall + 16, CTX);
    expect(shown.t).toBeCloseTo(settledAt(script), 6);
    expect(shown.stale).toBe(false);
    const after = stepLive(shown, wall + 32, CTX);
    expect(after.t - shown.t).toBeLessThan(0.05); // continues from there at natural speed
  });

  it('uses the settled state for every step in reduced-motion mode', () => {
    const script = live(burst(5));
    let s = startLive(live([]), 0);
    s = retargetLive(s, script, 100);
    s = stepLive(s, 116, { visible: true, reducedMotion: true });
    expect(s.t).toBeCloseTo(settledAt(script), 6);
    expect(isSettled(s, true)).toBe(true);
  });

  it('plays the tail at natural speed when the session ends and then settles into the end-state view', () => {
    const open = live([write(1000, 'auth'), write(2000, 'frontend')]);
    let s = run(startLive(open, 0), 8).state; // parked and idle
    const ended = live([write(1000, 'auth'), write(2000, 'frontend'), { kind: 'session.end', atMs: 3000, outcome: 'completed' }]);
    s = retargetLive(s, ended, s.wallMs);
    expect(s.t).toBeCloseTo(ended.live!.visits.at(-1)!.readyAt, 6);
    expect(isSettled(s, false)).toBe(false);
    s = run(s, ended.summary.detailAt - s.t + 0.1).state;
    expect(evaluateFrame(ended, graph, s.t).ui.summaryVisible).toBe(true);
    s = run(s, 60).state;
    expect(s.t).toBeCloseTo(settledAt(ended), 6);
    expect(isSettled(s, false)).toBe(true);
    const frame = evaluateFrame(ended, graph, s.t);
    expect(frame.ui.status).toBe('complete');
    expect(frame.ui.summaryDetailVisible).toBe(true);
  });

  it('shows the end state straight away to a viewer who arrives after the session ended', () => {
    const ended = live([...burst(3), { kind: 'session.end', atMs: 3000, outcome: 'completed' }]);
    const s = startLive(ended, 0);
    expect(s.t).toBeCloseTo(settledAt(ended), 6);
    expect(isSettled(s, false)).toBe(true);
  });

  it('marks a failed end as failed, not complete', () => {
    const ended = live([write(1000, 'auth'), { kind: 'session.end', atMs: 3000, outcome: 'failed' }]);
    expect(evaluateFrame(ended, graph, settledAt(ended)).ui.status).toBe('failed');
  });
});

describe('simulated live feed (deterministic clock)', () => {
  it('reproduces the same playhead for the same feed and time', () => {
    const events = [write(1000, 'auth'), write(2000, 'frontend'), write(3000, 'api')];
    const steps = [0, 1, 2, 3].map((i) => ({ wallMs: i * 1500, script: live(events.slice(0, i)) }));
    const a = simulateLive(steps, 5000);
    const b = simulateLive(steps, 5000);
    expect(a.t).toBe(b.t);
    expect(simulateLive(steps, 2000).t).toBeLessThan(a.t);
  });
});
