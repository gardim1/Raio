import { tokens } from '../../tokens';
import type { ArchitectureGraph } from '../architecture/model/types';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';

export type CtaState = 'hidden' | 'active' | 'quiet';

/** How long the "View changes" offer stays prominent before Raio returns to calm. */
export const CTA_PROMINENT_SECONDS = 20;
/** How long the Island shows "Claude finished" before reverting to its idle label. */
export const FINISHED_LABEL_SECONDS = 6;

export interface Presence {
  readonly completeAt: number | null;
  readonly cta: CtaState;
  readonly recentlyFinished: boolean;
  readonly activeNodeLabel: string | null;
}

/** Derives the companion's attention level from the frame — Raio never nags. */
export const derivePresence = (script: ChoreographyScript, graph: ArchitectureGraph, frame: FrameState, replay: boolean): Presence => {
  const completeCue = script.status.find((s) => s.state === 'complete' || s.state === 'failed' || s.state === 'incomplete');
  const completeAt = completeCue?.at ?? null;
  const t = frame.t;
  const offerAt = script.summary.detailAt + 0.4;
  let cta: CtaState = 'hidden';
  if (!replay && completeAt !== null && t >= offerAt) cta = t < offerAt + CTA_PROMINENT_SECONDS ? 'active' : 'quiet';
  return {
    completeAt,
    cta,
    recentlyFinished: completeAt !== null && t >= completeAt && t < completeAt + FINISHED_LABEL_SECONDS,
    activeNodeLabel: frame.ui.activeNodeId ? (graph.nodeById.get(frame.ui.activeNodeId)?.label ?? null) : null,
  };
};

const spring = (s: { stiffness: number; damping: number; mass: number }) => ({ type: 'spring' as const, stiffness: s.stiffness, damping: s.damping, mass: s.mass });

export const MORPH_TRANSITION = spring(tokens.motion.spring.modeMorph);
export const ISLAND_TRANSITION = spring(tokens.motion.spring.islandHover);
export const CROSSFADE = { duration: tokens.motion.duration.contentCrossfade / 1000, ease: [0.33, 1, 0.68, 1] as const };
