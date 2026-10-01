import { clamp } from '../../../shared/motion/easing';
import type { Vec } from '../../../shared/geometry/vec';
import { findEdge, findLink, requireEdge, requireNode } from '../../architecture/model/graph';
import type { ArchitectureEdge, ArchitectureGraph, NodeId } from '../../architecture/model/types';
import { AGENT_LABEL, type AgentEvent, formatOffset, RISK_LABEL, type SessionLog } from './events';
import type {
  ChoreographyScript,
  EdgeCue,
  NodeCue,
  OrbSegment,
  PulseCue,
  RiskCue,
  RiskKind,
  StoryEvent,
  ValidationCue,
} from './script';

/** Maximum replay length (seconds). */
export const REPLAY_BUDGET_SECONDS = 10;

/**
 * Beat durations (seconds) copied from the canonical concept. The compiler only
 * rearranges and time-scales these beats; it never invents new motion.
 */
export const BEAT = {
  leadIn: 1.0,
  wake: 0.4,
  approach: 0.7,
  primaryActivateOffset: 0.2,
  orbit: 0.9,
  satelliteActivateOffset: 0.65,
  satelliteStagger: 0.15,
  satelliteRevealOffset: 0.6,
  satelliteRevealDuration: 0.9,
  satellitePulseOffset: 0.8,
  satellitePulseDuration: 0.45,
  departArc: 0.25,
  departRevealOffset: 0.15,
  travelPulseOffset: 0.45,
  travelPulseDuration: 0.55,
  settle: 0.28,
  dwell: 0.45,
  warningArc: 0.25,
  warningToneOffset: 0.1,
  warningPillOffset: 0.3,
  startle: 0.35,
  warningDwell: 1.25,
  jump: 0.8,
  /* Tail — offsets from the last arrival E. Never time-scaled. */
  focusOut: 1.15,
  reveal: 1.25,
  firstValidation: 1.65,
  validationStep: 0.4,
  finalPulses: 1.9,
  finalPulseStep: 0.375,
  finalPulseDuration: 0.38,
  returnHome: 2.65,
  returnDuration: 0.9,
  complete: 2.85,
  settleTail: 3.05,
  summary: 3.25,
  summaryDetail: 3.6,
  happy: 3.5,
  rest: 3.55,
  gazeViewer: 3.85,
  warmGlowEnd: 2.25,
  end: 4.65,
} as const;

const HOME: Vec = { x: 480, y: 262 };
const ORBIT = { rx: 86, ry: 40 } as const;
const HOVER_OFFSET = 44;
const WARNING_HOVER_OFFSET = 42;
const MIN_TIME_SCALE = 0.35;
const FIXED_SECONDS = BEAT.leadIn + BEAT.wake + BEAT.end;

type Link = { readonly edge: ArchitectureEdge; readonly reversed: boolean };

interface Visit {
  readonly nodeId: NodeId;
  readonly via: Link | null;
  readonly satellites: NodeId[];
  readonly firstWriteMs: number;
}

interface NodeFacts {
  readonly files: Set<string>;
  readonly risks: { kind: RiskKind; atMs: number }[];
  readonly firstWriteMs: number;
}

interface SessionFacts {
  readonly facts: Map<NodeId, NodeFacts>;
  readonly order: NodeId[];
  readonly finalValidations: Map<'build' | 'tests', { status: 'passed' | 'failed'; atMs: number }>;
  readonly endMs: number;
  readonly failed: boolean;
}

/* 1. Facts ------------------------------------------------------------ */

const collectFacts = (events: readonly AgentEvent[]): SessionFacts => {
  const facts = new Map<NodeId, NodeFacts>();
  const order: NodeId[] = [];
  const ensure = (id: NodeId, atMs: number): NodeFacts => {
    let f = facts.get(id);
    if (!f) {
      f = { files: new Set(), risks: [], firstWriteMs: atMs };
      facts.set(id, f);
      order.push(id);
    }
    return f;
  };
  const finalValidations: SessionFacts['finalValidations'] = new Map();
  let endMs = 0;
  let failed = false;
  for (const e of events) {
    endMs = Math.max(endMs, e.atMs);
    if (e.kind === 'file.write') ensure(e.nodeId, e.atMs).files.add(e.path);
    else if (e.kind === 'risk') ensure(e.nodeId, e.atMs).risks.push({ kind: e.risk, atMs: e.atMs });
    else if (e.kind === 'validation' && e.status !== 'running') finalValidations.set(e.validation, { status: e.status, atMs: e.atMs });
    else if (e.kind === 'session.end') failed = e.outcome === 'failed';
  }
  return { facts, order, finalValidations, endMs, failed };
};

/* 2. Visits: primaries Raio flies to; satellites are callers revealed in place */

const planVisits = (graph: ArchitectureGraph, session: SessionFacts): Visit[] => {
  const visits: Visit[] = [];
  for (const id of session.order) {
    const current = visits.at(-1);
    const firstWriteMs = session.facts.get(id)?.firstWriteMs ?? 0;
    if (current && findEdge(graph, id, current.nodeId) && !findEdge(graph, current.nodeId, id)) {
      current.satellites.push(id);
      continue;
    }
    visits.push({ nodeId: id, via: current ? (findLink(graph, current.nodeId, id) ?? null) : null, satellites: [], firstWriteMs });
  }
  return visits;
};

/* Helpers -------------------------------------------------------------- */

const linkStart = (link: Link): Vec => link.edge.path.pointAt(link.reversed ? 1 : 0);

const travelDuration = (edge: ArchitectureEdge): number => clamp(0.55 + edge.path.length / 700, 0.6, 1.0);

/** Fraction along `link` (within its first 30%) closest to `point`, rounded to 0.01. */
const nearestFraction = (link: Link, point: Vec): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= 60; i++) {
    const f = (i / 60) * 0.3;
    const p = link.edge.path.pointAt(link.reversed ? 1 - f : f);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = f;
    }
  }
  return Math.round(best * 100) / 100;
};

const orbitPointAt = (center: Vec, angle: number): Vec => ({ x: center.x + ORBIT.rx * Math.cos(angle), y: center.y + ORBIT.ry * Math.sin(angle) });

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const nodeDetail = (f: NodeFacts | undefined): string => {
  const migrations = f?.risks.filter((r) => r.kind === 'migration').length ?? 0;
  return migrations > 0 ? plural(migrations, 'migration') : `${plural(f?.files.size ?? 0, 'file')} changed`;
};

/** Where a segment leaves Raio once it has finished. */
const segmentEnd = (graph: ArchitectureGraph, s: OrbSegment): Vec => {
  switch (s.kind) {
    case 'sleep':
    case 'wake':
    case 'hover':
    case 'rest':
      return s.at;
    case 'arc':
    case 'settle':
      return s.to;
    case 'orbit':
      return orbitPointAt(s.center, s.startAngle + 2 * Math.PI * s.turns);
    case 'edge':
      return requireEdge(graph, s.edgeId).path.pointAt(s.p1);
  }
};

/* 3. Public API --------------------------------------------------------- */

/**
 * Compiles a finished session into a semantic Session Replay of at most
 * REPLAY_BUDGET_SECONDS, using exactly the live motion vocabulary.
 * The output is consumed by `evaluateFrame`, like the canonical film.
 */
export const compileReplay = (log: SessionLog, graph: ArchitectureGraph): ChoreographyScript => {
  const session = collectFacts(log.events);
  const visits = planVisits(graph, session);
  const available = REPLAY_BUDGET_SECONDS - FIXED_SECONDS;

  let scale = 1;
  let script = compose(log, graph, visits, session, scale, false);
  for (let i = 0; i < 8 && script.duration > REPLAY_BUDGET_SECONDS + 0.05 && scale > MIN_TIME_SCALE; i++) {
    const content = script.duration - FIXED_SECONDS;
    scale = Math.max(MIN_TIME_SCALE, scale * (available / content));
    script = compose(log, graph, visits, session, scale, scale < 0.75);
  }
  return script;
};

/* 4. Composition --------------------------------------------------------- */

const compose = (
  log: SessionLog,
  graph: ArchitectureGraph,
  visits: readonly Visit[],
  session: SessionFacts,
  s: number,
  dropDwell: boolean,
): ChoreographyScript => {
  const { facts } = session;
  const orb: OrbSegment[] = [];
  const nodes: NodeCue[] = [];
  const edges: EdgeCue[] = [];
  const pulses: PulseCue[] = [];
  const risks: RiskCue[] = [];
  const story: StoryEvent[] = [];
  const blinks: number[] = [];
  const agent = AGENT_LABEL[log.agent];

  const wakeAt = BEAT.leadIn;
  orb.push({ kind: 'sleep', t0: 0, t1: wakeAt, at: HOME });
  orb.push({ kind: 'wake', t0: wakeAt, t1: wakeAt + BEAT.wake, at: HOME, hopHeight: 9 });
  story.push({ t: wakeAt, label: `${agent} started “${log.task}”`, tone: 'neutral', realTime: '00:00' });

  let t = wakeAt + BEAT.wake;
  let lastArrival = t;
  let firstRiskAt: number | null = null;
  let lastNodeWarned = false;

  const addRisks = (nodeId: NodeId, at: number, outOfScope: boolean): void => {
    const f = facts.get(nodeId);
    const kinds = [...(f?.risks ?? [])];
    if (outOfScope) kinds.push({ kind: 'outOfScope', atMs: f?.firstWriteMs ?? 0 });
    kinds.forEach((r, i) => {
      const riskAt = at + i * 0.2 * s;
      const pillAt = riskAt + (BEAT.warningPillOffset - BEAT.warningToneOffset) * s;
      risks.push({ nodeId, kind: r.kind, label: RISK_LABEL[r.kind], tone: 'warning', at: riskAt, pillAt });
      story.push({ t: riskAt, label: `${RISK_LABEL[r.kind]} in ${requireNode(graph, nodeId).label}`, nodeId, tone: 'warning', realTime: formatOffset(r.atMs) });
      firstRiskAt ??= riskAt;
    });
  };

  const activate = (nodeId: NodeId, at: number, warnAt: number | null): void => {
    const cue: NodeCue = { nodeId, activateAt: at, detail: nodeDetail(facts.get(nodeId)) };
    nodes.push(warnAt === null ? cue : { ...cue, toneShift: { tone: 'warning', at: warnAt } });
  };

  const revealSatellites = (visit: Visit, revealAt: number, activateAt: number): void => {
    visit.satellites.forEach((sat, i) => {
      const satAt = activateAt + i * BEAT.satelliteStagger * s;
      activate(sat, satAt, null);
      story.push({
        t: satAt,
        label: `${requireNode(graph, sat).label} connected to ${requireNode(graph, visit.nodeId).label}`,
        nodeId: sat,
        tone: 'cool',
        realTime: formatOffset(facts.get(sat)?.firstWriteMs ?? 0),
      });
      const edge = findEdge(graph, sat, visit.nodeId);
      if (!edge) return;
      const r = revealAt + i * BEAT.satelliteStagger * s;
      edges.push({ edgeId: edge.id, revealAt: r, revealDuration: BEAT.satelliteRevealDuration * s });
      pulses.push({ edgeId: edge.id, t0: r + BEAT.satellitePulseOffset * s, duration: BEAT.satellitePulseDuration, tone: 'cool' });
    });
  };

  const isOutOfScope = (visit: Visit, index: number): boolean =>
    index > 0 && visit.via === null && !visits.slice(0, index).some((v) => findLink(graph, v.nodeId, visit.nodeId));

  visits.forEach((visit, index) => {
    const node = requireNode(graph, visit.nodeId);
    const next = visits[index + 1];
    const outOfScope = isOutOfScope(visit, index);
    const warned = (facts.get(visit.nodeId)?.risks.length ?? 0) > 0 || outOfScope;
    const isLast = index === visits.length - 1;

    if (index === 0) {
      const outgoing = next?.via ? linkStart(next.via) : { x: node.position.x, y: node.position.y + ORBIT.ry };
      const startAngle = Math.atan2((outgoing.y - node.position.y) / ORBIT.ry, (outgoing.x - node.position.x) / ORBIT.rx);
      const approachStart = t;
      orb.push({ kind: 'arc', t0: t, t1: t + BEAT.approach * s, to: orbitPointAt(node.position, startAngle), lift: 26 });
      const activateAt = t + BEAT.primaryActivateOffset * s;
      t += BEAT.approach * s;
      const warnAt = warned ? t + BEAT.warningToneOffset * s : null;
      activate(visit.nodeId, activateAt, warnAt);
      blinks.push(activateAt);
      story.push({ t: activateAt, label: `Inspecting ${node.label}`, nodeId: node.id, tone: 'cool', realTime: formatOffset(visit.firstWriteMs) });
      if (warnAt !== null) addRisks(visit.nodeId, warnAt, outOfScope);
      revealSatellites(visit, approachStart + BEAT.satelliteRevealOffset * s, approachStart + BEAT.satelliteActivateOffset * s);
      orb.push({ kind: 'orbit', t0: t, t1: t + BEAT.orbit * s, nodeId: node.id, center: node.position, rx: ORBIT.rx, ry: ORBIT.ry, startAngle, turns: 1 });
      t += BEAT.orbit * s;
      lastArrival = t;
      lastNodeWarned = warned;
      return;
    }

    const previous = orb.at(-1)!;
    if (visit.via) {
      const via = visit.via;
      const duration = travelDuration(via.edge) * s;
      let p0 = 0;
      if (previous.kind === 'orbit') {
        p0 = nearestFraction(via, segmentEnd(graph, previous));
        edges.push({ edgeId: via.edge.id, revealAt: t - 0.05 * s, revealDuration: duration });
      } else {
        orb.push({ kind: 'arc', t0: t, t1: t + BEAT.departArc * s, to: linkStart(via), lift: 14 });
        edges.push({ edgeId: via.edge.id, revealAt: t + BEAT.departRevealOffset * s, revealDuration: duration + (BEAT.departArc - BEAT.departRevealOffset - 0.05) * s });
        t += BEAT.departArc * s;
      }
      orb.push({ kind: 'edge', t0: t, t1: t + duration, edgeId: via.edge.id, p0: via.reversed ? 1 - p0 : p0, p1: via.reversed ? 0 : 1 });
      if (!warned) pulses.push({ edgeId: via.edge.id, t0: t + BEAT.travelPulseOffset * s, duration: BEAT.travelPulseDuration, tone: 'cool', reversed: via.reversed });
      t += duration;
    } else {
      orb.push({ kind: 'arc', t0: t, t1: t + BEAT.jump * s, to: { x: node.position.x, y: node.position.y - HOVER_OFFSET }, lift: 50 });
      t += BEAT.jump * s;
    }

    const arrival = t;
    lastArrival = arrival;
    lastNodeWarned = warned;
    if (!warned) story.push({ t: arrival, label: `${node.label} updated`, nodeId: node.id, tone: 'cool', realTime: formatOffset(visit.firstWriteMs) });

    if (warned) {
      const warnAt = arrival + BEAT.warningToneOffset * s;
      activate(visit.nodeId, arrival, warnAt);
      if (visit.via) pulses.push({ edgeId: visit.via.edge.id, t0: arrival - 0.1 * s, duration: 0.4, tone: 'warning', reversed: visit.via.reversed });
      addRisks(visit.nodeId, warnAt, outOfScope);
      const hoverAt = { x: node.position.x, y: node.position.y - WARNING_HOVER_OFFSET };
      if (visit.via) {
        orb.push({ kind: 'arc', t0: t, t1: t + BEAT.warningArc * s, to: hoverAt, lift: 18 });
        t += BEAT.warningArc * s;
      }
      const until = isLast ? Infinity : arrival + BEAT.warningDwell * s;
      orb.push({ kind: 'hover', t0: t, t1: until, at: hoverAt, gaze: 'down', startle: { t0: t, duration: BEAT.startle, height: 11 } });
      if (!isLast) t = until;
    } else {
      activate(visit.nodeId, arrival, null);
      blinks.push(arrival + 0.05);
      const dwell = dropDwell && !isLast ? 0 : BEAT.dwell * s;
      if (visit.via && dwell > 0) {
        orb.push({ kind: 'settle', t0: t, t1: isLast ? Infinity : t + dwell, to: { x: node.position.x, y: node.position.y - HOVER_OFFSET }, duration: BEAT.settle });
        if (!isLast) t += dwell;
      }
    }
    revealSatellites(visit, arrival + BEAT.departRevealOffset * s, arrival + 0.25 * s);
  });

  /* Tail: reveal → validations → path pulses → return → summary ------- */
  const E = lastArrival;
  const leaveAt = E + BEAT.returnHome;
  const last = orb.at(-1)!;
  if (last.kind === 'hover' || last.kind === 'settle') {
    orb[orb.length - 1] = { ...last, t1: leaveAt };
  } else {
    orb.push({ kind: 'hover', t0: last.t1, t1: leaveAt, at: segmentEnd(graph, last), gaze: 'down' });
  }
  orb.push({ kind: 'arc', t0: leaveAt, t1: leaveAt + BEAT.returnDuration, to: HOME, lift: 60 });
  orb.push({ kind: 'rest', t0: E + BEAT.rest, t1: Infinity, at: HOME, gazeViewerAt: E + BEAT.gazeViewer });

  const validations: ValidationCue[] = [];
  let failures = 0;
  for (const kind of ['build', 'tests'] as const) {
    const result = session.finalValidations.get(kind);
    if (!result) continue;
    const at = E + BEAT.firstValidation + validations.length * BEAT.validationStep;
    validations.push({ kind, status: result.status, at });
    if (result.status === 'failed') failures++;
    story.push({
      t: at,
      label: `${kind === 'build' ? 'Build' : 'Tests'} ${result.status}`,
      tone: result.status === 'passed' ? 'success' : 'danger',
      realTime: formatOffset(result.atMs),
    });
  }

  const revealOrder = [...edges].sort((a, b) => a.revealAt - b.revealAt);
  const step = revealOrder.length > 3 ? Math.min(BEAT.finalPulseStep, 1.1 / revealOrder.length) : BEAT.finalPulseStep;
  const warnedNodes = new Set(nodes.filter((n) => n.toneShift).map((n) => n.nodeId));
  revealOrder.forEach((cue, i) => {
    const target = graph.edgeById.get(cue.edgeId)?.to;
    pulses.push({
      edgeId: cue.edgeId,
      t0: E + BEAT.finalPulses + i * step,
      duration: BEAT.finalPulseDuration,
      tone: target && warnedNodes.has(target) ? 'warning' : 'cool',
    });
  });

  const endState = session.failed || failures > 0 ? 'failed' : 'complete';
  story.push({
    t: E + BEAT.complete,
    label: endState === 'failed' ? `${agent} finished with failures` : `${agent} finished`,
    tone: endState === 'failed' ? 'danger' : 'neutral',
    realTime: formatOffset(session.endMs),
  });
  blinks.push(E + 1.05, E + 5.25);

  return {
    id: `replay-${log.id}`,
    agent: log.agent,
    task: log.task,
    duration: E + BEAT.end,
    home: HOME,
    orb,
    nodes,
    edges,
    pulses,
    risks,
    validations,
    status: [
      { at: 0, state: 'ready' },
      { at: wakeAt, state: 'working' },
      { at: E + BEAT.complete, state: endState },
    ],
    taskVisible: { from: wakeAt, to: E + BEAT.settleTail },
    camera: { focusIn: { t0: wakeAt + 0.3, duration: 0.8 }, focusOut: { t0: E + BEAT.focusOut, duration: 1.0 }, zoom: 1.13, follow: 0.5 },
    reveal: { t0: E + BEAT.reveal, duration: 0.8 },
    settle: { t0: E + BEAT.settleTail, duration: 0.8 },
    summary: { at: E + BEAT.summary, detailAt: E + BEAT.summaryDetail, systems: nodes.length, reviewCount: risks.length + failures },
    mood: {
      wakeAt,
      blinks,
      happy: { t0: E + BEAT.happy, duration: endState === 'failed' ? 0 : 1.55 },
      warmGlow: firstRiskAt !== null && lastNodeWarned ? { from: firstRiskAt, to: E + BEAT.warmGlowEnd } : null,
      calmAt: E + BEAT.summary,
    },
    story: [...story].sort((a, b) => a.t - b.t),
  };
};
