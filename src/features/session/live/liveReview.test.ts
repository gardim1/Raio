import { describe, expect, it } from 'vitest';
import { demoGraph } from '../../architecture/model/demoProject';
import { createGraph, NODE_SIZE } from '../../architecture/model/graph';
import type { PathGroup } from '../../project/classifyPath';
import { layoutGroups } from '../../project/layoutGroups';
import { compileReplay } from '../model/compileReplay';
import { evaluateFrame } from '../model/evaluateFrame';
import type { AgentEvent, SessionLog } from '../model/events';
import type { ChoreographyScript } from '../model/script';
import {
  isSettled,
  LAG_TARGET_SECONDS,
  type LiveState,
  NOTICE_PLAY_SECONDS,
  protectedTimes,
  RATE_MAX,
  retargetLive,
  settledAt,
  startLive,
  stepLive,
} from './liveDirector';
import { runLiveLoop } from './liveLoop';

/** Tests for the fixes that followed the independent review of LIVE-1 (LIVE-1b). */

const graph = createGraph(demoGraph.nodes, []);
const FRAME = 1000 / 60;
const CTX = { visible: true, reducedMotion: false } as const;

const write = (atMs: number, nodeId: string): AgentEvent => ({ kind: 'file.write', atMs, path: `${nodeId}/file-${atMs}.ts`, nodeId, change: 'modified' });
const risk = (atMs: number, nodeId: string): AgentEvent => ({ kind: 'risk', atMs, nodeId, risk: 'migration', detail: 'x' });
const validation = (atMs: number, status: 'running' | 'passed' | 'failed' | 'stale', kind: 'build' | 'tests' = 'tests'): AgentEvent => ({ kind: 'validation', atMs, validation: kind, status });
const end: AgentEvent = { kind: 'session.end', atMs: 9000, outcome: 'completed' };
const log = (events: AgentEvent[], id = 'live-test'): SessionLog => ({ id, agent: 'claude', task: 'Live test', project: 'acme-web', startedAt: '2026-10-01T14:02:00Z', events: [{ kind: 'session.start', atMs: 0 }, ...events] });
const live = (events: AgentEvent[], g = graph): ChoreographyScript => compileReplay(log(events), g, { live: true });
const NODES = ['auth', 'frontend', 'api', 'db'] as const;
const burst = (n: number, from = 1000): AgentEvent[] => Array.from({ length: n }, (_, i) => write(from + i * 10, NODES[i % NODES.length]!));

const run = (state: LiveState, seconds: number, ctx = CTX): LiveState => {
  let s = state;
  const start = state.wallMs;
  for (let ms = start + FRAME; ms <= start + seconds * 1000 + 1e-6; ms += FRAME) s = stepLive(s, ms, ctx);
  return s;
};

describe('idle cost: no always-on loop', () => {
  const fakeScheduler = () => {
    const queue = new Map<number, (now: number) => void>();
    let next = 1;
    return {
      request: (cb: (now: number) => void) => {
        queue.set(next, cb);
        return next++;
      },
      cancel: (h: number) => void queue.delete(h),
      pending: () => queue.size,
      flush: (now: number) => {
        const cbs = [...queue.values()];
        queue.clear();
        cbs.forEach((cb) => cb(now));
      },
    };
  };

  it('stops scheduling frames once an open session is parked and settled', () => {
    const script = live([write(1000, 'auth'), write(2000, 'frontend')]);
    let state = retargetLive(startLive(live([]), 0), script, 0);
    const sched = fakeScheduler();
    let paints = 0;
    runLiveLoop({ read: () => state, write: (v) => (state = v), ctx: CTX, schedule: sched, paint: () => paints++ });
    let now = 0;
    let frames = 0;
    while (sched.pending() > 0 && frames < 20_000) {
      now += FRAME;
      sched.flush(now);
      frames++;
    }
    expect(sched.pending()).toBe(0);
    expect(frames).toBeLessThan(20_000);
    expect(isSettled(state, false)).toBe(true);
    sched.flush(now + 60_000); // however long we wait, nothing is scheduled
    expect(sched.pending()).toBe(0);
    expect(paints).toBeGreaterThan(0);
  });

  it('keeps a recompile with the same content settled (no restart of the loop\'s work)', () => {
    const events = [write(1000, 'auth')];
    let state = run(startLive(live(events), 0), 120);
    expect(isSettled(state, false)).toBe(true);
    state = retargetLive(state, live(events), state.wallMs);
    expect(isSettled(state, false)).toBe(true);
  });

  it('shows the settled state with one frame in reduced motion, then schedules nothing', () => {
    const script = live(burst(3));
    let state = retargetLive(startLive(live([]), 0), script, 0);
    const sched = fakeScheduler();
    runLiveLoop({ read: () => state, write: (v) => (state = v), ctx: { visible: true, reducedMotion: true }, schedule: sched, paint: () => {} });
    sched.flush(16);
    expect(sched.pending()).toBe(0);
    expect(state.t).toBeCloseTo(settledAt(script), 6);
  });
});

describe('lag bound after a protected moment', () => {
  it('returns to <= 2 s behind soon after a protected moment at the front of a 100-stop burst', () => {
    let s = run(startLive(live([write(500, 'auth')]), 0), 1);
    const script = live([write(500, 'auth'), write(600, 'frontend'), risk(650, 'frontend'), ...burst(100, 700)]);
    s = retargetLive(s, script, s.wallMs);
    const horizon = script.live!.eventsEndAt;
    expect(horizon - s.t).toBeGreaterThan(RATE_MAX * LAG_TARGET_SECONDS * 5); // the skip was blocked by the notice
    const notice = script.risks[0]!;
    let guard = 0;
    // The notice plays out in full (ripples and pill) ...
    while (s.t < notice.at + NOTICE_PLAY_SECONDS - 0.1 && guard++ < 5000) {
      const next = stepLive(s, s.wallMs + FRAME, CTX);
      expect(next.t - s.t).toBeLessThanOrEqual(RATE_MAX * (FRAME / 1000) + 1e-9); // never a jump inside it
      s = next;
    }
    expect(guard).toBeLessThan(5000);
    // ... and right after it the view is back within the target.
    for (let i = 0; i < 12; i++) s = stepLive(s, s.wallMs + FRAME, CTX);
    expect((horizon - s.t) / s.rate).toBeLessThanOrEqual(LAG_TARGET_SECONDS + 1e-6);
    expect(horizon - s.t).toBeLessThanOrEqual(RATE_MAX * LAG_TARGET_SECONDS + 1e-6);
  });

  it('still plays the protected moment itself, one frame at a time, before catching up', () => {
    let s = run(startLive(live([write(500, 'auth')]), 0), 1);
    const script = live([write(500, 'auth'), write(600, 'frontend'), risk(650, 'frontend'), ...burst(100, 700)]);
    s = retargetLive(s, script, s.wallMs);
    const at = script.risks[0]!.at;
    let crossed = false;
    for (let i = 0; i < 5000 && !crossed; i++) {
      const next = stepLive(s, s.wallMs + FRAME, CTX);
      if (s.t < at && next.t >= at) {
        crossed = true;
        expect(next.t - s.t).toBeLessThanOrEqual(RATE_MAX * (FRAME / 1000) + 1e-9);
      }
      s = next;
    }
    expect(crossed).toBe(true);
  });
});

describe('checks across the session end and the project history', () => {
  it('keeps a check that was already shown when the session ends (earlier time kept)', () => {
    const events = [write(1000, 'auth'), write(2000, 'frontend'), validation(2500, 'passed')];
    const open = live(events);
    const ended = live([...events, end]);
    const shownAt = open.validations[0]!.at;
    const t = shownAt + 0.5;
    expect(evaluateFrame(open, graph, t).ui.validations.map((v) => v.status)).toEqual(['passed']);
    expect(evaluateFrame(ended, graph, t).ui.validations.map((v) => v.status)).toEqual(['passed']);
    expect(ended.validations[0]!.at).toBeLessThanOrEqual(shownAt);
  });

  it('turns a check that never reported into "incomplete" only once the session ended', () => {
    const events = [write(1000, 'auth'), validation(1500, 'running')];
    expect(live(events).validations.map((v) => v.status)).toEqual(['running']);
    expect(live([...events, end]).validations.map((v) => v.status)).toEqual(['incomplete']);
  });

  it("keeps each check's history: passed from its own time, stale from the change time", () => {
    // CORE-1 projection: `passed` logged at the result, a later `stale` at the first change after it.
    const script = live([write(1000, 'auth'), validation(1500, 'passed'), write(3000, 'frontend'), validation(3000, 'stale'), write(4000, 'api')]);
    expect(script.validations.map((v) => v.status)).toEqual(['passed', 'stale']);
    const [passed, stale] = script.validations;
    expect(passed!.at).toBeLessThan(stale!.at);
    const newest = (t: number) => evaluateFrame(script, graph, t).ui.validations.reduce((a, b) => (b.at >= a.at ? b : a)).status;
    expect(newest(passed!.at + 0.1)).toBe('passed');
    expect(newest(stale!.at + 0.1)).toBe('stale');
    expect(script.summary.checks).toBe('unverified');
    expect(protectedTimes(script)).toContain(stale!.at);
  });

  it('keeps a failure failed', () => {
    const script = live([write(1000, 'auth'), validation(1500, 'failed'), write(3000, 'frontend')]);
    expect(script.validations.map((v) => v.status)).toEqual(['failed']);
    expect(script.summary.checks).toBe('some-failed');
    expect(script.summary.reviewCount).toBe(1);
  });
});

describe('a new session', () => {
  it('uses the first-sight rule when the session changes, not a remap of the old playhead', () => {
    const first = live(burst(4));
    let s = run(startLive(first, 0), 3);
    const other = compileReplay(log([], 'another-session'), graph, { live: true });
    expect(other.id).not.toBe(first.id);
    s = retargetLive(s, other, s.wallMs);
    expect(s.t).toBe(0); // a just-started session plays from the wake
    expect(s.script).toBe(other);
  });

  it('keeps one identity for a live session, open or ended', () => {
    const events = [write(1000, 'auth')];
    expect(live([...events, end]).id).toBe(live(events).id);
  });
});

describe('live motion matches the approved reference', () => {
  it('enters the first stop from below (orbit starts at the bottom of the system)', () => {
    const orbit = live([write(1000, 'auth')]).orb.find((x) => x.kind === 'orbit');
    expect(orbit).toMatchObject({ kind: 'orbit', startAngle: Math.PI / 2 });
  });

  it('treats a revisit as a normal arrival: no node animation of its own', () => {
    const script = live([write(1000, 'auth'), write(2000, 'frontend'), write(3000, 'auth')]);
    expect(script.nodes.find((n) => n.nodeId === 'auth')).not.toHaveProperty('retouchAt');
    const revisit = script.live!.visits[2]!;
    expect(evaluateFrame(script, graph, revisit.arrivalAt + 0.09).nodes.get('auth')!.bounce).toBeCloseTo(0, 6);
  });

  it('blinks while parked on the reference cadence (irregular 3.6-4.7 s gaps) and stops after ~32 s', () => {
    const script = live([write(1000, 'auth')]);
    const parkedAt = script.live!.eventsEndAt;
    const idle = script.mood.blinks.filter((b) => b > parkedAt).sort((a, b) => a - b);
    expect(idle.length).toBeGreaterThanOrEqual(5);
    const gaps = idle.slice(1).map((b, i) => b - idle[i]!);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(3.6 - 1e-9);
      expect(g).toBeLessThanOrEqual(4.7 + 1e-9);
    }
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(1);
    expect(idle.at(-1)! - parkedAt).toBeLessThanOrEqual(33);
    expect(idle.at(-1)! - parkedAt).toBeGreaterThan(25);
  });
});

/* Parking and orbit against the real CORE-1 layouts ------------------------------------- */

const groupsOf = (count: number): PathGroup[] =>
  Array.from({ length: count }, (_, i) => ({ groupId: `g${String(i).padStart(2, '0')}`, label: `Group ${String(i).padStart(2, '0')}`, kind: 'other' as const }));

const gapToRect = (p: { x: number; y: number }, c: { x: number; y: number }, halfW: number, halfH: number): number =>
  Math.hypot(Math.max(Math.abs(p.x - c.x) - halfW, 0), Math.max(Math.abs(p.y - c.y) - halfH, 0));

/** The full orb body (11) plus the float amplitude (2.5) must clear every other system. */
const BODY_CLEARANCE = 11 + 2.5;
/** The glow (radius 30, only its brightest core matters) must not wash over another system's label band. */
const GLOW_CLEARANCE = 30 * 0.5;
const PILL_DEPTH = 28;

describe('parking and orbit against the project layouts (1..13 groups)', () => {
  it.each([1, 2, 3, 4, 6, 8, 9, 10, 12, 13])('never overlaps another system, its label or a notice pill with %i groups', (count) => {
    const map = layoutGroups(groupsOf(count));
    const noticeIndex = Math.min(1, count - 1);
    // For every system, a session whose latest stop is that system (once with a notice, once plain): the
    // whole interval the orb sits parked there is sampled, as is the first stop's orbit.
    map.nodes.forEach((target, ti) => {
      for (const withNotice of [false, true]) {
        const events: AgentEvent[] = [];
        const noticed = new Set<string>();
        map.nodes.slice(0, ti + 1).forEach((n, i) => {
          events.push(write(1000 + i * 100, n.id));
          if (i === noticeIndex && ti >= noticeIndex) {
            events.push(risk(1050 + i * 100, n.id));
            noticed.add(n.id);
          }
        });
        if (withNotice && !noticed.has(target.id)) {
          events.push(risk(5000, target.id));
          noticed.add(target.id);
        }
        const script = compileReplay(log(events), map, { live: true });
        const last = script.live!.visits.at(-1)!;
        const check = (t: number, what: string): void => {
          const p = evaluateFrame(script, map, t).orb.position;
          for (const n of map.nodes.filter((x) => x.id !== last.nodeId)) {
            const hasPill = true; // the pill area is reserved under every system, whether or not a notice came yet
            const body = gapToRect(p, { x: n.position.x, y: n.position.y + (hasPill ? PILL_DEPTH / 2 : 0) }, NODE_SIZE.width / 2, NODE_SIZE.height / 2 + (hasPill ? PILL_DEPTH : 0));
            expect(body, `${count} groups, ${target.id}${withNotice ? '+notice' : ''} ${what} t=${t.toFixed(2)}: body vs ${n.id}`).toBeGreaterThan(BODY_CLEARANCE);
            const glow = gapToRect(p, { x: n.position.x, y: n.position.y + 4 }, NODE_SIZE.width / 2, 16);
            expect(glow, `${count} groups, ${target.id}${withNotice ? '+notice' : ''} ${what} t=${t.toFixed(2)}: glow vs label of ${n.id}`).toBeGreaterThan(GLOW_CLEARANCE);
          }
          // Nor on its own pill when a notice hangs under it.
          {
            const own = map.nodeById.get(last.nodeId)!.position;
            expect(gapToRect(p, { x: own.x, y: own.y + 34 + PILL_DEPTH / 2 }, 70, PILL_DEPTH / 2), `${what} own pill`).toBeGreaterThan(BODY_CLEARANCE);
          }
          expect(p.x, what).toBeGreaterThan(8);
          expect(p.x, what).toBeLessThan(map.world.width - 8);
          expect(p.y, what).toBeGreaterThan(8);
          expect(p.y, what).toBeLessThan(map.world.height - 8);
        };
        let sampled = 0;
        for (let t = last.readyAt + 0.02; t <= last.readyAt + 6; t += 0.1) {
          check(t, 'parked');
          sampled++;
        }
        expect(sampled).toBeGreaterThan(0);
        const orbit = script.orb.find((x) => x.kind === 'orbit')!;
        for (let t = orbit.t0; t <= orbit.t1; t += 0.05) {
          const p = evaluateFrame(script, map, t).orb.position;
          const first = script.live!.visits[0]!.nodeId;
          for (const n of map.nodes.filter((x) => x.id !== first)) {
            const hasPill = true; // the pill area is reserved under every system, whether or not a notice came yet
            const body = gapToRect(p, { x: n.position.x, y: n.position.y + (hasPill ? PILL_DEPTH / 2 : 0) }, NODE_SIZE.width / 2, NODE_SIZE.height / 2 + (hasPill ? PILL_DEPTH : 0));
            expect(body, `${count} groups orbit around ${first} t=${t.toFixed(2)} vs ${n.id}`).toBeGreaterThan(BODY_CLEARANCE);
          }
        }
      }
    });
  });

  it('keeps earlier stops exactly as they were when a later notice arrives (prefix-stable)', () => {
    for (const count of [3, 9, 12]) {
      const map = layoutGroups(groupsOf(count));
      const ids = map.nodes.map((n) => n.id);
      const base: AgentEvent[] = ids.slice(0, Math.min(5, count)).map((id, i) => write(1000 + i * 100, id));
      const before = compileReplay(log(base), map, { live: true });
      // A notice on an earlier system, on the current one, and on a system not visited yet.
      for (const target of [ids[0]!, ids[Math.min(4, count) - 1]!, ids[count - 1]!]) {
        const after = compileReplay(log([...base, risk(9000, target)]), map, { live: true });
        const stops = before.live!.visits.length;
        expect(after.live!.visits.slice(0, stops).map((v) => [v.nodeId, v.arrivalAt, v.readyAt])).toEqual(before.live!.visits.map((v) => [v.nodeId, v.arrivalAt, v.readyAt]));
        // Every orb segment up to the last earlier stop's ready time is identical (the open tail hover may differ).
        const upTo = before.live!.visits.at(-1)!.readyAt;
        const early = (script: ChoreographyScript) => script.orb.filter((x) => x.t0 < upTo - 1e-9 && x.kind !== 'hover');
        expect(early(after)).toEqual(early(before));
      }
    }
  });

  it('keeps the first stop to one turn, entered from below, then settles to the parking spot', () => {
    for (const count of [3, 12]) {
      const map = layoutGroups(groupsOf(count));
      const script = compileReplay(log([write(1000, map.nodes[0]!.id)]), map, { live: true });
      const i = script.orb.findIndex((x) => x.kind === 'orbit');
      const orbit = script.orb[i]!;
      expect(orbit).toMatchObject({ turns: 1, startAngle: Math.PI / 2 });
      expect(orbit.t1 - orbit.t0).toBeCloseTo(0.9, 6);
      expect(script.orb[i + 1]).toMatchObject({ kind: 'settle' });
    }
  });

  it('parks above a system by default and moves away only when something sits within ~76 px', () => {
    const roomy = layoutGroups(groupsOf(3));
    const script = live([write(1000, roomy.nodes[0]!.id)], roomy);
    const node = roomy.nodes[0]!;
    const rest = script.orb.at(-1)!;
    expect(rest.kind).toBe('hover');
    if (rest.kind === 'hover') expect(rest.at.y).toBeLessThan(node.position.y);
  });
});
