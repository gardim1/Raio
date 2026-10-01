import { type Tone, tokens } from '../../../tokens';
import {
  clamp,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  lerp,
  progress,
  springBump,
} from '../../../shared/motion/easing';
import { arcVec, lerpVec, type Vec } from '../../../shared/geometry/vec';
import { requireEdge } from '../../architecture/model/graph';
import type { ArchitectureGraph, EdgeId, NodeId } from '../../architecture/model/types';
import type { AgentStatusState, ChoreographyScript, OrbSegment, RiskCue, ValidationCue } from './script';

const ORB = tokens.motion.orb;
const WORLD_CENTER: Vec = { x: 500, y: 260 };

export interface OrbFrame {
  readonly position: Vec;
  readonly scale: number;
  readonly opacity: number;
  /** Body squash: rotate to the velocity heading, stretch along it. */
  readonly headingDeg: number;
  readonly stretch: number;
  readonly behindNodeId: NodeId | null;
  readonly gaze: Vec;
  readonly eyeOpen: number;
  readonly happy: number;
  readonly glowCool: number;
  readonly glowWarm: number;
  readonly glowRadius: number;
  readonly trail: readonly { readonly position: Vec; readonly opacity: number }[];
}

export interface NodeFrame {
  readonly activation: number;
  readonly bounce: number;
  readonly tone: Tone;
  readonly toneAmount: number;
  readonly offset: Vec;
  readonly opacity: number;
  readonly detailOpacity: number;
  /** Un-dimmed 0→1 progress of the detail line; drives the label lift. */
  readonly detailProgress: number;
  readonly detail: string | null;
  readonly touched: boolean;
}

export interface EdgeFrame {
  readonly revealed: boolean;
  readonly draw: number;
  readonly opacity: number;
  readonly glowOpacity: number;
  readonly width: number;
  /** Colour at the end of the line (warm when the target turned amber). */
  readonly endTone: Tone;
  readonly endToneAmount: number;
}

export interface PulseFrame {
  readonly key: string;
  readonly position: Vec;
  readonly opacity: number;
  readonly tone: Tone;
}

export interface RiskFrame {
  readonly cue: RiskCue;
  readonly ripples: readonly { readonly scale: number; readonly opacity: number }[];
  readonly pill: { readonly opacity: number; readonly offsetY: number; readonly scale: number };
}

export interface UiFrame {
  readonly status: AgentStatusState;
  readonly taskVisible: boolean;
  readonly hint: 'waiting' | 'following' | 'hidden';
  readonly validations: readonly ValidationCue[];
  readonly summaryVisible: boolean;
  readonly summaryDetailVisible: boolean;
  readonly wordmarkVisible: boolean;
  readonly finished: boolean;
  readonly activeNodeId: NodeId | null;
  readonly activeRisk: RiskCue | null;
}

export interface FrameState {
  readonly t: number;
  readonly camera: { readonly scale: number; readonly center: Vec };
  readonly orb: OrbFrame;
  readonly nodes: ReadonlyMap<NodeId, NodeFrame>;
  readonly edges: ReadonlyMap<EdgeId, EdgeFrame>;
  readonly pulses: readonly PulseFrame[];
  readonly risks: readonly RiskFrame[];
  readonly ui: UiFrame;
  /** 0→1 dimming of untouched systems during the path reveal. */
  readonly revealDim: number;
  readonly settle: number;
}

/* ------------------------------------------------------------------ */
/* Raio position                                                       */
/* ------------------------------------------------------------------ */

const segmentAt = (script: ChoreographyScript, t: number): { segment: OrbSegment; index: number } => {
  const segments = script.orb;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (t < s.t1 || i === segments.length - 1) return { segment: s, index: i };
  }
  throw new Error('Script has no orb segments');
};

/** Position of Raio at time t (world units). Pure and continuous across segments. */
export const orbPosition = (script: ChoreographyScript, graph: ArchitectureGraph, t: number): Vec => {
  const { segment, index } = segmentAt(script, Math.max(0, t));
  return positionInSegment(script, graph, segment, index, Math.max(0, t));
};

const startOf = (script: ChoreographyScript, graph: ArchitectureGraph, index: number): Vec => {
  if (index === 0) return script.home;
  const previous = script.orb[index - 1]!;
  return positionInSegment(script, graph, previous, index - 1, previous.t1);
};

const positionInSegment = (
  script: ChoreographyScript,
  graph: ArchitectureGraph,
  s: OrbSegment,
  index: number,
  t: number,
): Vec => {
  const span = s.t1 - s.t0;
  const k = span > 0 && Number.isFinite(span) ? clamp((t - s.t0) / span) : 0;
  switch (s.kind) {
    case 'sleep':
      return { x: s.at.x, y: s.at.y + Math.sin(t * 1.6) * ORB.sleepBreathAmplitude };
    case 'wake':
      return {
        x: s.at.x,
        y: s.at.y + Math.sin(s.t0 * 1.6) * ORB.sleepBreathAmplitude * (1 - k) - s.hopHeight * Math.sin(Math.PI * k),
      };
    case 'arc':
      return arcVec(startOf(script, graph, index), s.to, easeInOutCubic(k), s.lift);
    case 'orbit': {
      const angle = s.startAngle + 2 * Math.PI * s.turns * easeInOutCubic(k);
      return { x: s.center.x + s.rx * Math.cos(angle), y: s.center.y + s.ry * Math.sin(angle) };
    }
    case 'edge':
      return requireEdge(graph, s.edgeId).path.pointAt(lerp(s.p0, s.p1, easeInOutCubic(k)));
    case 'settle':
      return lerpVec(startOf(script, graph, index), s.to, easeOutBack(progress(t, s.t0, s.duration)));
    case 'hover': {
      if (s.startle && t < s.startle.t0 + s.startle.duration) {
        const hop = t >= s.startle.t0 ? s.startle.height * Math.sin((Math.PI * (t - s.startle.t0)) / s.startle.duration) : 0;
        return { x: s.at.x, y: s.at.y - hop };
      }
      const floatFrom = s.startle ? s.startle.t0 + s.startle.duration : s.t0;
      return { x: s.at.x, y: s.at.y + Math.sin((t - floatFrom) * ORB.floatAngularSpeed) * ORB.floatAmplitude };
    }
    case 'rest': {
      const since = t - s.t0;
      return { x: s.at.x, y: s.at.y + Math.sin(since * ORB.restAngularSpeed) * ORB.floatAmplitude * clamp(since / 0.6) };
    }
  }
};

/* ------------------------------------------------------------------ */
/* Frame                                                                */
/* ------------------------------------------------------------------ */

const statusAt = (script: ChoreographyScript, t: number): AgentStatusState => {
  let state: AgentStatusState = 'ready';
  for (const cue of script.status) if (t >= cue.at) state = cue.state;
  return state;
};

const computeOrb = (script: ChoreographyScript, graph: ArchitectureGraph, t: number): OrbFrame => {
  const position = orbPosition(script, graph, t);
  const before = orbPosition(script, graph, Math.max(0, t - 0.016));
  const after = orbPosition(script, graph, t + 0.016);
  const vx = (after.x - before.x) / 0.032;
  const vy = (after.y - before.y) / 0.032;
  const speed = Math.hypot(vx, vy);
  const { segment } = segmentAt(script, t);
  const mood = script.mood;

  const sleeping = segment.kind === 'sleep';
  let depthScale = 1;
  let behindNodeId: NodeId | null = null;
  let gaze: Vec = { x: 0, y: 0 };

  if (segment.kind === 'orbit') {
    const k = clamp((t - segment.t0) / (segment.t1 - segment.t0));
    const angle = segment.startAngle + 2 * Math.PI * segment.turns * easeInOutCubic(k);
    const depth = Math.sin(angle);
    depthScale = ORB.orbitDepthScaleMin + (1 - ORB.orbitDepthScaleMin) * ((depth + 1) / 2);
    if (depth < ORB.orbitBehindThreshold) behindNodeId = segment.nodeId;
    const dx = segment.center.x - position.x;
    const dy = segment.center.y - position.y;
    const len = Math.hypot(dx, dy) || 1;
    gaze = { x: (dx / len) * ORB.gazeMaxX, y: (dy / len) * ORB.gazeMaxY };
  } else if (segment.kind === 'hover' && segment.gaze === 'down') {
    gaze = { x: 0, y: 1.8 };
  } else if (speed > 40) {
    gaze = { x: (vx / speed) * ORB.gazeMaxX, y: (vy / speed) * 1.4 };
  } else if (segment.kind === 'rest' && t > segment.gazeViewerAt) {
    gaze = { x: 0, y: -0.4 };
  }

  let eyeOpen = 1;
  if (sleeping) eyeOpen = 0.15;
  else if (t < mood.wakeAt + 0.25) eyeOpen = lerp(0.15, 1, easeOutCubic(progress(t, mood.wakeAt, 0.25)));
  for (const blink of mood.blinks) {
    const d = t - blink;
    if (d > 0 && d < 0.16) eyeOpen *= 1 - Math.sin((Math.PI * d) / 0.16) * 0.92;
  }
  for (const s of script.orb) {
    if (s.kind === 'hover' && s.startle) {
      const from = s.startle.t0 - 0.05;
      if (t > from && t < from + 0.55) eyeOpen *= 1 + 0.35 * Math.sin((Math.PI * (t - from)) / 0.55);
    }
  }
  const happy = progress(t, mood.happy.t0, 0.2) * (1 - progress(t, mood.happy.t0 + mood.happy.duration, 0.2));

  const working = progress(t, mood.wakeAt, 0.4) * (1 - 0.5 * progress(t, mood.calmAt, 0.8));
  const warm = mood.warmGlow ? progress(t, mood.warmGlow.from, 0.3) * (1 - progress(t, mood.warmGlow.to, 0.6)) : 0;
  const glowRadius = 30 + ORB.glowPulseAmplitude * Math.sin(t * 3) * working;

  const wakeBounce = springBump(t - mood.wakeAt);
  const scale = (sleeping ? 0.92 : 1) * depthScale * (1 + 0.08 * wakeBounce);
  const opacity = sleeping ? tokens.opacity.orbSleeping + 0.08 * Math.sin(t * 1.6) : 1;

  const trailFactor = clamp(speed / ORB.trailSpeedForFull);
  const trail = Array.from({ length: ORB.trailCount }, (_, i) => {
    const tt = t - ORB.trailStepSeconds * (i + 1);
    if (tt < 0 || trailFactor < 0.02) return { position, opacity: 0 };
    return { position: orbPosition(script, graph, tt), opacity: tokens.opacity.trailMax * (1 - i / ORB.trailCount) * trailFactor };
  });

  return {
    position,
    scale,
    opacity,
    headingDeg: (Math.atan2(vy, vx) * 180) / Math.PI,
    stretch: Math.min(speed / ORB.squashVelocityDivisor, ORB.squashMaxStretch),
    behindNodeId,
    gaze,
    eyeOpen,
    happy,
    glowCool: (0.28 + 0.5 * working) * (1 - warm * 0.8),
    glowWarm: warm * 0.85,
    glowRadius,
    trail,
  };
};

/** Computes everything drawn at time `t`. Deterministic: same inputs → same frame. */
export const evaluateFrame = (script: ChoreographyScript, graph: ArchitectureGraph, t: number): FrameState => {
  const orb = computeOrb(script, graph, t);

  const a1 = orbPosition(script, graph, Math.max(0, t - 0.25));
  const a2 = orbPosition(script, graph, Math.max(0, t - 0.5));
  const anchor = { x: (orb.position.x + a1.x + a2.x) / 3, y: (orb.position.y + a1.y + a2.y) / 3 };
  const { focusIn, focusOut, zoom, follow } = script.camera;
  const weight = easeInOutCubic(progress(t, focusIn.t0, focusIn.duration)) * (1 - easeInOutCubic(progress(t, focusOut.t0, focusOut.duration)));
  const camera = {
    scale: 1 + (zoom - 1) * weight,
    center: { x: lerp(WORLD_CENTER.x, anchor.x, follow * weight), y: lerp(WORLD_CENTER.y, anchor.y, follow * weight) },
  };

  const revealDim = easeInOutCubic(progress(t, script.reveal.t0, script.reveal.duration));
  const settle = progress(t, script.settle.t0, script.settle.duration);

  const cueByNode = new Map(script.nodes.map((c) => [c.nodeId, c]));
  const nodes = new Map<NodeId, NodeFrame>();
  let activeNodeId: NodeId | null = null;
  let latestActivation = -Infinity;
  for (const node of graph.nodes) {
    const cue = cueByNode.get(node.id);
    if (!cue) {
      const dx = node.position.x - WORLD_CENTER.x;
      const dy = node.position.y - WORLD_CENTER.y;
      const len = Math.hypot(dx, dy) || 1;
      nodes.set(node.id, {
        activation: 0,
        bounce: 0,
        tone: 'cool',
        toneAmount: 0,
        offset: { x: (dx / len) * 10 * revealDim, y: (dy / len) * 10 * revealDim },
        opacity: tokens.opacity.dormantNode - 0.45 * revealDim,
        detailOpacity: 0,
        detailProgress: 0,
        detail: null,
        touched: false,
      });
      continue;
    }
    if (t >= cue.activateAt && cue.activateAt > latestActivation) {
      latestActivation = cue.activateAt;
      activeNodeId = node.id;
    }
    const activation = easeOutCubic(progress(t, cue.activateAt, 0.45)) * (1 - 0.22 * settle);
    const toneAmount = cue.toneShift ? easeInOutCubic(progress(t, cue.toneShift.at, 0.5)) : 0;
    const bounce = springBump(t - cue.activateAt) + (cue.toneShift ? (0.04 / 0.07) * springBump(t - cue.toneShift.at) : 0);
    const detailProgress = easeOutCubic(progress(t, cue.activateAt + 0.2, 0.45));
    nodes.set(node.id, {
      activation,
      bounce,
      tone: cue.toneShift?.tone ?? 'cool',
      toneAmount,
      offset: { x: 0, y: 0 },
      opacity: 1,
      detailOpacity: detailProgress * (1 - 0.2 * settle),
      detailProgress,
      detail: cue.detail,
      touched: true,
    });
  }

  const edges = new Map<EdgeId, EdgeFrame>();
  const cueByEdge = new Map(script.edges.map((c) => [c.edgeId, c]));
  for (const edge of graph.edges) {
    const cue = cueByEdge.get(edge.id);
    if (!cue) {
      edges.set(edge.id, {
        revealed: false,
        draw: 1,
        opacity: 1 - 0.6 * revealDim,
        glowOpacity: 0,
        width: tokens.border.connectionDormant,
        endTone: 'cool',
        endToneAmount: 0,
      });
      continue;
    }
    const draw = easeInOutCubic(progress(t, cue.revealAt, cue.revealDuration));
    const visible = draw > 0 ? 1 : 0;
    const target = nodes.get(edge.to);
    edges.set(edge.id, {
      revealed: true,
      draw,
      opacity: visible * (0.85 - 0.2 * settle + 0.15 * revealDim),
      glowOpacity: visible * (0.28 - 0.1 * settle),
      width: tokens.border.connection + 0.4 * revealDim,
      endTone: target?.tone ?? 'cool',
      endToneAmount: target?.toneAmount ?? 0,
    });
  }

  const pulses: PulseFrame[] = [];
  script.pulses.forEach((cue, i) => {
    const k = progress(t, cue.t0, cue.duration);
    if (k <= 0 || k >= 1) return;
    const path = requireEdge(graph, cue.edgeId).path;
    const along = easeInOutCubic(k);
    pulses.push({ key: `${cue.edgeId}-${i}`, position: path.pointAt(cue.reversed ? 1 - along : along), opacity: Math.sin(Math.PI * k), tone: cue.tone });
  });

  let activeRisk: RiskCue | null = null;
  const risks: RiskFrame[] = script.risks.map((cue) => {
    if (t >= cue.at) activeRisk = cue;
    const ripples = [0, 1, 2].map((i) => {
      const k = progress(t, cue.at + i * 0.38, 1.2);
      const on = k > 0 && k < 1;
      return { scale: 1 + 0.42 * easeOutCubic(k), opacity: on ? (1 - easeOutCubic(k)) * tokens.opacity.rippleMax : 0 };
    });
    const ap = progress(t, cue.pillAt, 0.55);
    return {
      cue,
      ripples,
      pill: { opacity: easeOutCubic(ap), offsetY: lerp(48, 60, easeOutCubic(ap)), scale: lerp(0.6, 1, easeOutBack(ap)) },
    };
  });

  const status = statusAt(script, t);
  const summaryAt = script.summary.at;
  const ui: UiFrame = {
    status,
    taskVisible: t >= script.taskVisible.from && t < script.taskVisible.to,
    hint: t >= summaryAt - 0.15 ? 'hidden' : t >= script.mood.wakeAt ? 'following' : 'waiting',
    validations: script.validations.filter((v) => t >= v.at),
    summaryVisible: t >= summaryAt,
    summaryDetailVisible: t >= script.summary.detailAt,
    wordmarkVisible: script.wordmarkAt !== undefined && t >= script.wordmarkAt,
    finished: status === 'complete' || status === 'finished' || status === 'failed',
    activeNodeId,
    activeRisk,
  };

  return { t, camera, orb, nodes, edges, pulses, risks, ui, revealDim, settle };
};
