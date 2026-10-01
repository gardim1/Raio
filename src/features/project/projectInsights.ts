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

/** One state of a build/test check, in log order. The last entry per kind is the current state. */
export interface ValidationInsight {
  readonly kind: ValidationKind;
  /** What the surfaces show. `stale` replaces `passed`/`failed` when the project changed afterwards. */
  readonly status: ValidationStatus;
  /** What the command itself reported, before staleness. */
  readonly recordedStatus: ValidationStatus;
  readonly atMs: number;
  /** When the first later project change happened (only for `stale`). */
  readonly staleSinceMs?: number;
}

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
