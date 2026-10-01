import type { RiskKind, ValidationKind, ValidationStatus } from '../session/model/script';
import type { SessionSnapshot } from '../../platform/desktopBridge';
import type { EditConfidence } from './diskEvidence';

/** Shown next to a disk change that no reported edit accounts for. */
export const UNASSIGNED_CHANGE_NOTE = 'Changed in project, author unknown';

/** An edit the agent reported, checked against what the filesystem watcher saw (a heuristic, not proof of authorship). */
export interface ReportedEditInsight {
  readonly path: string;
  readonly groupId: string;
  /** Milliseconds since the session start. */
  readonly atMs: number;
  /** `consistent`: the same path changed on disk within the window. `not-observed`: reported only. */
  readonly disk: 'consistent' | 'not-observed';
  readonly confidence: EditConfidence;
  /** Another change on this path inside the window that no reported edit accounts for. */
  readonly concurrentChange: boolean;
}

/** A disk change during the session that no reported edit accounts for. Never counted as an agent write. */
export interface UnassignedChangeInsight {
  readonly path: string;
  readonly groupId: string;
  readonly groupLabel: string;
  readonly atMs: number;
  /** Factual notice derived from the path name only, when it is a migration, manifest or config file. */
  readonly notice: Exclude<RiskKind, 'outOfScope'> | null;
}

/**
 * One state of a build/test check, in time order. The last entry per kind is the current state.
 * A pass the project outlived has two entries: `passed` when it happened, then `stale` at the change.
 * A failure never changes status: it stays `failed` and carries `codeChangedSinceMs`.
 */
export interface ValidationInsight {
  readonly kind: ValidationKind;
  /** What the surfaces show. Only `stale` replaces a `passed`; `failed` is never replaced. */
  readonly status: ValidationStatus;
  /** What the command itself reported, before staleness. */
  readonly recordedStatus: ValidationStatus;
  /** When this state began, in milliseconds since the session start (a `stale` entry: the change time). */
  readonly atMs: number;
  /** When the first later project change happened (only on the `stale` entry of a pass). */
  readonly staleSinceMs?: number;
  /** When the first later project change happened (only on a `failed` entry): "failed · code changed since". */
  readonly codeChangedSinceMs?: number;
}

/** Short wording for one validation state; a failure keeps its failed wording even when the code changed. */
export const describeValidation = (v: ValidationInsight): string => {
  const name = v.kind === 'tests' ? 'Tests' : 'Build';
  if (v.status === 'stale') return `${name}: stale (passed, then code changed)`;
  if (v.status === 'failed') return v.codeChangedSinceMs === undefined ? `${name}: failed` : `${name}: failed · code changed since`;
  return `${name}: ${v.status}`;
};

/** The current state of each check (the last entry per kind), in kind order of first appearance. */
export const currentValidations = (validations: readonly ValidationInsight[]): readonly ValidationInsight[] => {
  const latest = new Map<ValidationKind, ValidationInsight>();
  for (const v of validations) latest.set(v.kind, v);
  return [...latest.values()];
};

/** What the replay log cannot carry. UI wiring is a later task; every claim here is a heuristic unless noted. */
export interface ProjectInsights {
  /** Wording for the UI: groups are guessed from folder names. */
  readonly note: string;
  /** The projection never creates edges; the map says relationships are unknown. */
  readonly relationships: 'unknown';
  /** Two or more actors (main agent, subagents) interleaved. States overlap only, never a causal chain. */
  readonly parallel: boolean;
  readonly actors: number;
  readonly reportedEdits: readonly ReportedEditInsight[];
  readonly unassigned: readonly UnassignedChangeInsight[];
  readonly validations: readonly ValidationInsight[];
}

export interface ProjectedSession {
  readonly snapshot: SessionSnapshot;
  readonly insights: ProjectInsights;
}
