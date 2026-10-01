import { clamp } from '../../../shared/motion/easing';
import type { Vec } from '../../../shared/geometry/vec';
import { findEdge, findLink, requireEdge, requireNode } from '../../architecture/model/graph';
import type { ArchitectureEdge, ArchitectureGraph, NodeId } from '../../architecture/model/types';
import { AGENT_LABEL, type AgentEvent, formatOffset, RISK_LABEL, type SessionLog } from './events';
import { orbitRadii, parkingSpot } from './parking';
import type {
  CheckVerdict,
  ChoreographyScript,
  EdgeCue,
  NodeCue,
  OrbSegment,
  PulseCue,
  RiskCue,
  RiskKind,
  LiveVisitMark,
  StoryEvent,
  ValidationCue,
  ValidationKind,
  ValidationStatus,
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
  /** Live scripts: the notices raised at this very stop (replay uses the per-system facts instead). */
  readonly risks?: { kind: RiskKind; atMs: number }[];
}

export interface CompileOptions {
  /**
   * Compile for the live director: stops follow event order at natural speed (a system may be visited
   * again), a session without an end signal has no tail, and the orb stays parked at the latest stop.
   * Same beats and segments as the replay; no second model.
   */
  readonly live?: boolean;
}

interface NodeFacts {
  readonly files: Set<string>;
  /** Whether a read was observed here; "Inspecting" is only claimed with that evidence. */
  inspected: boolean;
  readonly risks: { kind: RiskKind; atMs: number }[];
  readonly firstWriteMs: number;
}

interface SessionFacts {
  readonly facts: Map<NodeId, NodeFacts>;
  readonly order: NodeId[];
  readonly finalValidations: Map<ValidationKind, { status: ValidationStatus; atMs: number }>;
  /** Live: every check result in event order (consecutive repeats of one status dropped), so a pass and a later stale both show. */
  readonly history: { kind: ValidationKind; status: ValidationStatus; atMs: number }[];
  readonly endMs: number;
  readonly failed: boolean;
  /** False when the log has no `session.end`: the replay must not claim completion. */
  readonly ended: boolean;
}

/* 1. Facts ------------------------------------------------------------ */

const collectFacts = (events: readonly AgentEvent[], live = false): SessionFacts => {
  const facts = new Map<NodeId, NodeFacts>();
  const order: NodeId[] = [];
  const ensure = (id: NodeId, atMs: number): NodeFacts => {
    let f = facts.get(id);
    if (!f) {
      f = { files: new Set(), inspected: false, risks: [], firstWriteMs: atMs };
      facts.set(id, f);
      order.push(id);
    }
    return f;
  };
  const finalValidations: SessionFacts['finalValidations'] = new Map();
  const history: SessionFacts['history'] = [];
  let endMs = 0;
  let failed = false;
  let ended = false;
  const reads = new Set<NodeId>();
  for (const e of events) {
    endMs = Math.max(endMs, e.atMs);
    if (e.kind === 'file.write') ensure(e.nodeId, e.atMs).files.add(e.path);
    else if (e.kind === 'file.read') reads.add(e.nodeId);
    else if (e.kind === 'risk') ensure(e.nodeId, e.atMs).risks.push({ kind: e.risk, atMs: e.atMs });
    else if (e.kind === 'validation') {
      finalValidations.set(e.validation, { status: e.status, atMs: e.atMs });
      const previous = history.filter((h) => h.kind === e.validation).at(-1);
      if (!previous || previous.status !== e.status) history.push({ kind: e.validation, status: e.status, atMs: e.atMs });
    }
    else if (e.kind === 'session.end') {
      failed = e.outcome === 'failed';
      ended = true;
    }
  }
  for (const id of reads) {
    const f = facts.get(id);
    if (f) f.inspected = true;
  }
  // A check that never reported a result by the end of the log is incomplete, never dropped.
  // While a live session is still open the check may simply still be running.
  if (!live || ended) for (const [kind, v] of finalValidations) if (v.status === 'running') finalValidations.set(kind, { ...v, status: 'incomplete' });
  if (live && ended) {
    for (const kind of ['build', 'tests'] as const) {
      const index = history.map((h) => h.kind).lastIndexOf(kind);
      if (index >= 0 && history[index]!.status === 'running') history[index] = { ...history[index]!, status: 'incomplete' };
    }
  }
  return { facts, order, finalValidations, history, endMs, failed, ended };
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

/**
 * Live stops, in event order. Consecutive writes to one system are one stop; a notice on the system
 * Raio is already at is its own stop (so it is played when it arrives, without travelling).
 */
const planLiveVisits = (events: readonly AgentEvent[], graph: ArchitectureGraph): Visit[] => {
  const visits: Visit[] = [];
  for (const e of events) {
    if (e.kind !== 'file.write' && e.kind !== 'risk') continue;
    const current = visits.at(-1);
    if (current && current.nodeId === e.nodeId && (e.kind === 'file.write' || (current.risks?.length ?? 0) > 0)) {
      if (e.kind === 'risk') current.risks?.push({ kind: e.risk, atMs: e.atMs });
      continue;
    }
    visits.push({
      nodeId: e.nodeId,
      via: current ? (findLink(graph, current.nodeId, e.nodeId) ?? null) : null,
      satellites: [],
      firstWriteMs: e.atMs,
      risks: e.kind === 'risk' ? [{ kind: e.risk, atMs: e.atMs }] : [],
    });
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

const orbitPointAt = (center: Vec, angle: number, rx: number = ORBIT.rx, ry: number = ORBIT.ry): Vec => ({ x: center.x + rx * Math.cos(angle), y: center.y + ry * Math.sin(angle) });

/** Parked blinks follow the reference film's cadence: irregular 3.6-4.7 s gaps, none after ~32 s. */
const PARKED_BLINK_GAPS = [3.6, 4.7, 4.5, 4.3, 4.4] as const;
const PARKED_BLINK_SPAN = 32;
const parkedBlinks = (from: number): number[] => {
  const out: number[] = [];
  let at = from + 1.05;
  for (let i = 0; at - from <= PARKED_BLINK_SPAN; i++) {
    out.push(at);
    at += PARKED_BLINK_GAPS[i % PARKED_BLINK_GAPS.length]!;
  }
  return out;
};

/** The newest cue of each check: what a summary may claim. */
const latestPerKind = (cues: readonly ValidationCue[]): ValidationCue[] => {
  const latest = new Map<ValidationKind, ValidationCue>();
  for (const cue of cues) {
    const current = latest.get(cue.kind);
    if (!current || cue.at >= current.at) latest.set(cue.kind, cue);
  }
  return [...latest.values()];
};

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

const VALIDATION_TONE: Record<ValidationStatus, StoryEvent['tone']> = {
  running: 'cool',
  passed: 'success',
  failed: 'danger',
  unknown: 'neutral',
  incomplete: 'neutral',
  stale: 'neutral',
};

const validationLabel = (kind: ValidationKind, status: ValidationStatus): string => {
  const name = kind === 'build' ? 'Build' : 'Tests';
  if (status === 'unknown') return `${name}: result unknown`;
  if (status === 'stale') return `${name}: stale (code changed after the run)`;
  return `${name} ${status}`;
};

/** "Everything validated" requires observed passing results for every observed check. */
export const checkVerdict = (validations: readonly ValidationCue[]): CheckVerdict => {
  if (validations.length === 0) return 'none-ran';
  if (validations.some((v) => v.status === 'failed')) return 'some-failed';
  if (validations.every((v) => v.status === 'passed')) return 'all-passed';
  return 'unverified';
};

/* 3. Public API --------------------------------------------------------- */

/**
 * Compiles a finished session into a semantic Session Replay of at most
 * REPLAY_BUDGET_SECONDS, using exactly the live motion vocabulary.
 * The output is consumed by `evaluateFrame`, like the canonical film.
 */
export const compileReplay = (log: SessionLog, graph: ArchitectureGraph, options: CompileOptions = {}): ChoreographyScript => {
  if (options.live) return compose(log, graph, planLiveVisits(log.events, graph), collectFacts(log.events, true), 1, false, true);
  const session = collectFacts(log.events);
  let visits = planVisits(graph, session);
  let script = fitToBudget(log, graph, visits, session);
  // When even the fastest pacing overflows, group low-value systems into the previous stop
  // (activated in place, no flight). Systems with warnings are never grouped away.
  while (script.duration > REPLAY_BUDGET_SECONDS + 0.05) {
    const grouped = groupOneVisit(graph, visits, session);
    if (!grouped) break;
    visits = grouped;
    script = fitToBudget(log, graph, visits, session);
  }
  return script;
};

const fitToBudget = (log: SessionLog, graph: ArchitectureGraph, visits: readonly Visit[], session: SessionFacts): ChoreographyScript => {
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

/** Folds the smallest risk-free stop (never the first) into the stop before it. Returns null when nothing can be grouped. */
const groupOneVisit = (graph: ArchitectureGraph, visits: readonly Visit[], session: SessionFacts): Visit[] | null => {
  let pick = -1;
  for (let i = 1; i < visits.length; i++) {
    const facts = session.facts.get(visits[i]!.nodeId);
    if ((facts?.risks.length ?? 0) > 0) continue;
    if (pick === -1 || (facts?.files.size ?? 0) < (session.facts.get(visits[pick]!.nodeId)?.files.size ?? 0)) pick = i;
  }
  if (pick === -1) return null;
  const folded = visits[pick]!;
  const previous = visits[pick - 1]!;
  const next: Visit[] = [...visits];
  next[pick - 1] = { ...previous, satellites: [...previous.satellites, folded.nodeId, ...folded.satellites] };
  next.splice(pick, 1);
  const after = next[pick];
  if (after) next[pick] = { ...after, via: findLink(graph, previous.nodeId, after.nodeId) ?? null };
  return next;
};

/* 4. Composition --------------------------------------------------------- */

const compose = (
  log: SessionLog,
  graph: ArchitectureGraph,
  visits: readonly Visit[],
  session: SessionFacts,
  s: number,
  dropDwell: boolean,
  live = false,
): ChoreographyScript => {
  const { facts } = session;
  const open = live && !session.ended;
  const marks: LiveVisitMark[] = [];
  const risksOf = (visit: Visit): readonly { kind: RiskKind; atMs: number }[] => visit.risks ?? facts.get(visit.nodeId)?.risks ?? [];
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
  story.push({ t: wakeAt, label: log.taskIsPlaceholder ? `${agent} started a session` : `${agent} started “${log.task}”`, tone: 'neutral', realTime: '00:00' });

  let t = wakeAt + BEAT.wake;
  let lastArrival = t;
  let firstRiskAt: number | null = null;
  let lastNodeWarned = false;

  /** Risks come only from observed facts (or paths the user marked out of scope); never from map topology. */
  const addRisks = (nodeId: NodeId, kinds: readonly { kind: RiskKind; atMs: number }[], at: number): void => {
    kinds.forEach((r, i) => {
      const riskAt = at + i * 0.2 * s;
      const pillAt = riskAt + (BEAT.warningPillOffset - BEAT.warningToneOffset) * s;
      risks.push({ nodeId, kind: r.kind, label: RISK_LABEL[r.kind], tone: 'warning', at: riskAt, pillAt });
      story.push({ t: riskAt, label: `${RISK_LABEL[r.kind]} in ${requireNode(graph, nodeId).label}`, nodeId, tone: 'warning', realTime: formatOffset(r.atMs) });
      firstRiskAt ??= riskAt;
    });
  };

  const activate = (nodeId: NodeId, at: number, warnAt: number | null): void => {
    const known = nodes.findIndex((n) => n.nodeId === nodeId);
    if (known >= 0) {
      // A live revisit is a normal arrival; the system only turns amber if it now has a notice.
      const cue = nodes[known]!;
      if (warnAt !== null && !cue.toneShift) nodes[known] = { ...cue, toneShift: { tone: 'warning' as const, at: warnAt } };
      return;
    }
    const cue: NodeCue = { nodeId, activateAt: at, detail: nodeDetail(facts.get(nodeId)) };
    nodes.push(warnAt === null ? cue : { ...cue, toneShift: { tone: 'warning', at: warnAt } });
  };

  const revealSatellites = (visit: Visit, revealAt: number, activateAt: number): void => {
    visit.satellites.forEach((sat, i) => {
      const satAt = activateAt + i * BEAT.satelliteStagger * s;
      activate(sat, satAt, null);
      story.push({
        t: satAt,
        label: `${requireNode(graph, sat).label} updated`,
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

  /** Where Raio parks at a system. Replay: above, as designed. Live: above unless something else is within reach. */
  const spotOf = (node: { id: NodeId; position: Vec }, warned: boolean) =>
    live
      ? parkingSpot(graph, requireNode(graph, node.id), warned)
      : { side: 'above' as const, point: { x: node.position.x, y: node.position.y - (warned ? WARNING_HOVER_OFFSET : HOVER_OFFSET) } };

  /** An edge is revealed once; later trips along it only pulse. */
  const revealEdge = (cue: EdgeCue): void => {
    if (!edges.some((e) => e.edgeId === cue.edgeId)) edges.push(cue);
  };

  visits.forEach((visit, index) => {
    const node = requireNode(graph, visit.nodeId);
    const next = visits[index + 1];
    const visitRisks = risksOf(visit);
    const warned = visitRisks.length > 0;
    const isLast = index === visits.length - 1;

    if (index === 0) {
      // Live: the orbit keeps the design's size unless a neighbour is within reach.
      const { rx, ry } = live ? orbitRadii(graph, node, ORBIT.rx, ORBIT.ry) : ORBIT;
      const outgoing = next?.via ? linkStart(next.via) : { x: node.position.x, y: node.position.y + ORBIT.ry };
      const startAngle = Math.atan2((outgoing.y - node.position.y) / ORBIT.ry, (outgoing.x - node.position.x) / ORBIT.rx);
      const approachStart = t;
      orb.push({ kind: 'arc', t0: t, t1: t + BEAT.approach * s, to: orbitPointAt(node.position, startAngle, rx, ry), lift: 26 });
      const activateAt = t + BEAT.primaryActivateOffset * s;
      t += BEAT.approach * s;
      const warnAt = warned ? t + BEAT.warningToneOffset * s : null;
      activate(visit.nodeId, activateAt, warnAt);
      blinks.push(activateAt);
      const firstLabel = facts.get(visit.nodeId)?.inspected ? `Inspecting ${node.label}` : `${node.label} updated`;
      story.push({ t: activateAt, label: firstLabel, nodeId: node.id, tone: 'cool', realTime: formatOffset(visit.firstWriteMs) });
      if (warnAt !== null) addRisks(visit.nodeId, visitRisks, warnAt);
      revealSatellites(visit, approachStart + BEAT.satelliteRevealOffset * s, approachStart + BEAT.satelliteActivateOffset * s);
      // One turn entered from below, as designed; live then settles to the parking spot with the usual settle motion.
      const spot = spotOf(node, warned);
      orb.push({ kind: 'orbit', t0: t, t1: t + BEAT.orbit * s, nodeId: node.id, center: node.position, rx, ry, startAngle, turns: 1 });
      t += BEAT.orbit * s;
      if (live) {
        orb.push({ kind: 'settle', t0: t, t1: t + BEAT.settle, to: spot.point, duration: BEAT.settle });
        t += BEAT.settle;
        marks.push({ nodeId: visit.nodeId, arrivalAt: activateAt, readyAt: t, notices: visitRisks.length });
      }
      lastArrival = t;
      lastNodeWarned = warned;
      return;
    }

    const previous = orb.at(-1)!;
    // Live: a notice on the system Raio is already parked at plays in place; nothing to travel.
    const inPlace = live && visits[index - 1]?.nodeId === visit.nodeId;
    if (inPlace) {
      /* arrival = now */
    } else if (visit.via) {
      const via = visit.via;
      const duration = travelDuration(via.edge) * s;
      let p0 = 0;
      if (previous.kind === 'orbit') {
        p0 = nearestFraction(via, segmentEnd(graph, previous));
        revealEdge({ edgeId: via.edge.id, revealAt: t - 0.05 * s, revealDuration: duration });
      } else {
        orb.push({ kind: 'arc', t0: t, t1: t + BEAT.departArc * s, to: linkStart(via), lift: 14 });
        revealEdge({ edgeId: via.edge.id, revealAt: t + BEAT.departRevealOffset * s, revealDuration: duration + (BEAT.departArc - BEAT.departRevealOffset - 0.05) * s });
        t += BEAT.departArc * s;
      }
      orb.push({ kind: 'edge', t0: t, t1: t + duration, edgeId: via.edge.id, p0: via.reversed ? 1 - p0 : p0, p1: via.reversed ? 0 : 1 });
      if (!warned) pulses.push({ edgeId: via.edge.id, t0: t + BEAT.travelPulseOffset * s, duration: BEAT.travelPulseDuration, tone: 'cool', reversed: via.reversed });
      t += duration;
    } else {
      orb.push({ kind: 'arc', t0: t, t1: t + BEAT.jump * s, to: spotOf(node, false).point, lift: 50 });
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
      addRisks(visit.nodeId, visitRisks, warnAt);
      const hoverAt = inPlace ? segmentEnd(graph, previous) : spotOf(node, true).point;
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
        orb.push({ kind: 'settle', t0: t, t1: isLast ? Infinity : t + dwell, to: spotOf(node, false).point, duration: BEAT.settle });
        if (!isLast) t += dwell;
      }
    }
    revealSatellites(visit, arrival + BEAT.departRevealOffset * s, arrival + 0.25 * s);
    if (live) {
      const readyAt = warned ? arrival + BEAT.warningDwell * s : visit.via && !inPlace ? arrival + BEAT.dwell * s : arrival;
      marks.push({ nodeId: visit.nodeId, arrivalAt: arrival, readyAt, notices: visitRisks.length });
    }
  });

  /* Live: end every script on a floating hover at the latest stop (the tail, if any, takes it from there). */
  if (live) {
    const parked = orb.at(-1)!;
    if (parked.kind === 'settle') {
      const settled = parked.t0 + parked.duration;
      orb[orb.length - 1] = { ...parked, t1: Math.min(parked.t1, settled) };
      orb.push({ kind: 'hover', t0: settled, t1: Infinity, at: parked.to, gaze: 'down' });
    } else if (parked.kind !== 'hover') {
      orb.push({ kind: 'hover', t0: parked.t1, t1: Infinity, at: segmentEnd(graph, parked), gaze: 'down' });
    }
  }

  /* Live checks: each result of the log appears when the latest stop that preceded it is done and keeps its own time, so a
   * pass stays a pass until the later `stale` entry, a failure stays failed, and nothing a viewer has already
   * seen moves when the session ends. */
  const wakeEnd = wakeAt + BEAT.wake;
  const liveValidations: ValidationCue[] = [];
  if (live) {
    for (const h of session.history) {
      const at = visits.reduce((latest, v, i) => (v.firstWriteMs <= h.atMs ? Math.max(latest, marks[i]?.readyAt ?? wakeEnd) : latest), wakeEnd);
      liveValidations.push({ kind: h.kind, status: h.status, at });
      story.push({ t: at, label: validationLabel(h.kind, h.status), tone: VALIDATION_TONE[h.status], realTime: formatOffset(h.atMs) });
    }
  }
  const liveFailedChecks = latestPerKind(liveValidations).filter((v) => v.status === 'failed').length;

  if (open) {
    /* Open live session: no tail; the orb stays parked at the latest stop. */
    const eventsEndAt = marks.at(-1)?.readyAt ?? wakeEnd;
    // Parked blinks follow the reference cadence and stop after ~32 s: after the last one nothing is scheduled.
    const idleBlinks = parkedBlinks(eventsEndAt);
    return {
      id: `live-${log.id}`,
      agent: log.agent,
      task: log.task,
      ...(log.taskIsPlaceholder ? { taskIsPlaceholder: true } : {}),
      duration: eventsEndAt,
      home: HOME,
      orb,
      nodes,
      edges,
      pulses,
      risks,
      validations: liveValidations,
      status: [
        { at: 0, state: 'ready' },
        { at: wakeAt, state: 'working' },
      ],
      taskVisible: { from: wakeAt, to: Infinity },
      camera: { focusIn: { t0: wakeAt + 0.3, duration: 0.8 }, focusOut: { t0: Infinity, duration: 1.0 }, zoom: 1.13, follow: 0.5 },
      reveal: { t0: Infinity, duration: 0.8 },
      settle: { t0: Infinity, duration: 0.8 },
      summary: { at: Infinity, detailAt: Infinity, systems: nodes.length, reviewCount: risks.length + liveFailedChecks, checks: checkVerdict(latestPerKind(liveValidations)) },
      mood: {
        wakeAt,
        blinks: [...blinks, ...idleBlinks],
        happy: { t0: Infinity, duration: 0 },
        warmGlow: firstRiskAt !== null && lastNodeWarned ? { from: firstRiskAt, to: Infinity } : null,
        calmAt: Infinity,
      },
      story: [...story].sort((a, b) => a.t - b.t),
      live: { visits: marks, open: true, eventsEndAt, quietAt: (idleBlinks.at(-1) ?? eventsEndAt) + 0.2 },
    };
  }

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

  const validations: ValidationCue[] = live ? liveValidations : [];
  let failures = live ? liveFailedChecks : 0;
  if (!live) {
    for (const kind of ['build', 'tests'] as const) {
      const result = session.finalValidations.get(kind);
      if (!result) continue;
      const at = E + BEAT.firstValidation + validations.length * BEAT.validationStep;
      validations.push({ kind, status: result.status, at });
      if (result.status === 'failed') failures++;
      story.push({ t: at, label: validationLabel(kind, result.status), tone: VALIDATION_TONE[result.status], realTime: formatOffset(result.atMs) });
    }
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

  const endState = session.failed || failures > 0 ? 'failed' : session.ended ? 'complete' : 'incomplete';
  story.push({
    t: E + BEAT.complete,
    label: endState === 'failed' ? `${agent} finished with failures` : endState === 'incomplete' ? 'Session ended without a completion signal' : `${agent} finished`,
    tone: endState === 'failed' ? 'danger' : 'neutral',
    realTime: formatOffset(session.endMs),
  });
  blinks.push(E + 1.05, E + 5.25);

  return {
    id: `${live ? 'live' : 'replay'}-${log.id}`,
    agent: log.agent,
    task: log.task,
    ...(log.taskIsPlaceholder ? { taskIsPlaceholder: true } : {}),
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
    summary: { at: E + BEAT.summary, detailAt: E + BEAT.summaryDetail, systems: nodes.length, reviewCount: risks.length + failures, checks: checkVerdict(live ? latestPerKind(validations) : validations) },
    mood: {
      wakeAt,
      blinks,
      happy: { t0: E + BEAT.happy, duration: endState === 'failed' ? 0 : 1.55 },
      warmGlow: firstRiskAt !== null && lastNodeWarned ? { from: firstRiskAt, to: E + BEAT.warmGlowEnd } : null,
      calmAt: E + BEAT.summary,
    },
    story: [...story].sort((a, b) => a.t - b.t),
    ...(live ? { live: { visits: marks, open: false, eventsEndAt: marks.at(-1)?.readyAt ?? E, quietAt: marks.at(-1)?.readyAt ?? E } } : {}),
  };
};
