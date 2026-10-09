import type { Tone } from '../../../tokens';
import type { Vec } from '../../../shared/geometry/vec';
import type { EdgeId, NodeId } from '../../architecture/model/types';

/**
 * A Choreography Script is the declarative description of one Raio sequence
 * (the live concept film, or a compiled Session Replay). It is pure data:
 * `evaluateFrame(script, graph, t)` turns it into everything that is drawn at time t.
 * All times are in seconds from the start of the sequence.
 */

/** `unknown`: the agent could not be identified; it is never shown as Claude or Codex. */
export type AgentId = 'claude' | 'codex' | 'unknown';
/** `incomplete`: the session stopped without an end signal, so Raio cannot say it completed. */
export type AgentStatusState = 'ready' | 'working' | 'complete' | 'finished' | 'failed' | 'incomplete';
/**
 * Factual notices. `outOfScope` only comes from paths the user marked; public-API detection
 * is out of v1 (see docs/ARCHITECTURE.md).
 */
export type RiskKind = 'migration' | 'dependency' | 'config' | 'outOfScope';
export type ValidationKind = 'build' | 'tests';
/**
 * `unknown`: the check was observed but no result was captured.
 * `incomplete`: it was still running when the session ended.
 * `stale`: a result was recorded, but the project changed on disk after it (whoever made the change).
 */
export type ValidationStatus = 'running' | 'passed' | 'failed' | 'unknown' | 'incomplete' | 'stale';
/** What the completion summary may honestly claim about checks. */
export type CheckVerdict = 'all-passed' | 'some-failed' | 'unverified' | 'none-observed';
export type Gaze = 'auto' | 'down' | 'viewer';

/** Raio's path is a list of contiguous motion segments. A segment without `from` starts where the previous ended. */
export type OrbSegment =
  | { readonly kind: 'sleep'; readonly t0: number; readonly t1: number; readonly at: Vec }
  | { readonly kind: 'wake'; readonly t0: number; readonly t1: number; readonly at: Vec; readonly hopHeight: number }
  | { readonly kind: 'arc'; readonly t0: number; readonly t1: number; readonly to: Vec; readonly lift: number }
  | {
      readonly kind: 'orbit';
      readonly t0: number;
      readonly t1: number;
      readonly nodeId: NodeId;
      readonly center: Vec;
      readonly rx: number;
      readonly ry: number;
      readonly startAngle: number;
      readonly turns: number;
    }
  | { readonly kind: 'edge'; readonly t0: number; readonly t1: number; readonly edgeId: EdgeId; readonly p0: number; readonly p1: number }
  | { readonly kind: 'settle'; readonly t0: number; readonly t1: number; readonly to: Vec; readonly duration: number }
  | {
      readonly kind: 'hover';
      readonly t0: number;
      readonly t1: number;
      readonly at: Vec;
      readonly gaze: Gaze;
      readonly startle?: { readonly t0: number; readonly duration: number; readonly height: number };
    }
  | { readonly kind: 'rest'; readonly t0: number; readonly t1: number; readonly at: Vec; readonly gazeViewerAt: number };

export interface NodeCue {
  readonly nodeId: NodeId;
  readonly activateAt: number;
  /** Shown under the label once active, e.g. "3 files changed". */
  readonly detail: string;
  /** Tone shift after activation (warning = amber, danger = coral). */
  readonly toneShift?: { readonly tone: Exclude<Tone, 'cool'>; readonly at: number };
}

export interface EdgeCue {
  readonly edgeId: EdgeId;
  readonly revealAt: number;
  readonly revealDuration: number;
}

export interface PulseCue {
  readonly edgeId: EdgeId;
  readonly t0: number;
  readonly duration: number;
  readonly tone: Tone;
  readonly reversed?: boolean;
}

export interface RiskCue {
  readonly nodeId: NodeId;
  readonly kind: RiskKind;
  readonly label: string;
  readonly tone: Exclude<Tone, 'cool' | 'success'>;
  readonly at: number;
  readonly pillAt: number;
}

export interface ValidationCue {
  readonly kind: ValidationKind;
  readonly status: ValidationStatus;
  readonly at: number;
  /** Contract detail explaining an unknown result; only known values are displayed. */
  readonly detail?: string;
  readonly program?: string;
}

export interface StatusCue {
  readonly at: number;
  readonly state: AgentStatusState;
}

/** One line in the event timeline; also a tick on the replay scrubber. */
export interface StoryEvent {
  readonly t: number;
  readonly label: string;
  readonly nodeId?: NodeId;
  readonly tone: Tone | 'neutral';
  /** Wall-clock offset in the real session, e.g. "04:12". */
  readonly realTime?: string;
}

/** One stop of the orb in a live script (chronological: a system may be visited again). */
export interface LiveVisitMark {
  readonly nodeId: NodeId;
  /** When the system is touched (first stop: its activation; later stops: the orb's arrival). */
  readonly arrivalAt: number;
  /** When the next stop may depart without a visual jump: the end of this stop's own animation and dwell. */
  readonly readyAt: number;
  /** Notices raised at this stop. */
  readonly notices: number;
}

/** Present only on scripts compiled for the live director (`compileReplay(..., { live: true })`). */
export interface LiveMarks {
  readonly visits: readonly LiveVisitMark[];
  /** True while the session has no end signal: the script has no tail and the orb stays parked at the latest stop. */
  readonly open: boolean;
  /** All observed events have been played once the playhead reaches this time. */
  readonly eventsEndAt: number;
  /** Open sessions: after this nothing is scheduled any more (the last parked blink); the playhead may stop. */
  readonly quietAt: number;
}

export interface ChoreographyScript {
  readonly id: string;
  readonly agent: AgentId;
  readonly task: string;
  /** True when `task` is a generated label rather than the user's request. */
  readonly taskIsPlaceholder?: boolean;
  /** Content length; the sequence is considered finished after this. */
  readonly duration: number;
  /** The resting spot Raio returns to. */
  readonly home: Vec;
  readonly orb: readonly OrbSegment[];
  readonly nodes: readonly NodeCue[];
  readonly edges: readonly EdgeCue[];
  readonly pulses: readonly PulseCue[];
  readonly risks: readonly RiskCue[];
  readonly validations: readonly ValidationCue[];
  readonly status: readonly StatusCue[];
  readonly taskVisible: { readonly from: number; readonly to: number };
  readonly camera: { readonly focusIn: Window; readonly focusOut: Window; readonly zoom: number; readonly follow: number };
  readonly reveal: Window;
  readonly settle: Window;
  readonly summary: {
    readonly at: number;
    readonly detailAt: number;
    readonly systems: number;
    readonly reviewCount: number;
    readonly checks: CheckVerdict;
  };
  readonly mood: {
    readonly wakeAt: number;
    readonly blinks: readonly number[];
    readonly happy: Window;
    readonly warmGlow: { readonly from: number; readonly to: number } | null;
    readonly calmAt: number;
  };
  readonly story: readonly StoryEvent[];
  readonly live?: LiveMarks;
  /** Film-only: wordmark reveal time. Never used inside the app. */
  readonly wordmarkAt?: number;
}

export interface Window {
  readonly t0: number;
  readonly duration: number;
}
