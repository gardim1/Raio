/**
 * Raio event contract v1: the minimised, validated record the desktop core persists and the
 * renderer projects. See docs/ARCHITECTURE.md ("Event contract v1"). The Rust core produces the
 * same shape (src-tauri/src/event.rs); keep them in sync.
 */

export const RAIO_EVENT_SCHEMA = 1;

export type EventSource = 'claude-hook' | 'fs-watch' | 'fixture';
export type Provenance = 'agent-reported' | 'filesystem-observed' | 'fixture';
export type Attribution = 'session' | 'unassigned';
export type EventAgent = 'claude' | 'codex' | 'unknown';

export type RaioEventKind =
  | 'session.started'
  | 'session.ended'
  | 'turn.ended'
  | 'file.inspected'
  | 'file.edit.attempted'
  | 'file.edit.reported'
  | 'file.edit.failed'
  | 'file.changed'
  | 'command.observed'
  | 'command.result';

export type CommandClass = 'test' | 'build' | 'migration' | 'install' | 'other';

/** Change reported by the agent's tool (`create`/`update`) or observed on disk. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'unknown';

export interface RaioEventEvidence {
  readonly toolUseId?: string;
  readonly toolName?: string;
  /** Present only when captured: parsed from a failure ("Exit code N"), or 0 for a tool success event. */
  readonly exitCode?: number;
  /** How `exitCode` was obtained, so the UI can say what it rests on. */
  readonly exitCodeSource?: 'failure-message' | 'tool-success';
  readonly commandClass?: CommandClass;
  /** Program name only (e.g. "npm"), never the full command line. */
  readonly program?: string;
  readonly change?: ChangeKind;
  /** e.g. SessionStart "startup" | "resume" | "compact", SessionEnd reason. */
  readonly detail?: string;
}

export interface RaioEvent {
  readonly schema: 1;
  readonly id: string;
  readonly source: EventSource;
  readonly provenance: Provenance;
  readonly attribution: Attribution;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly agent: EventAgent;
  readonly subagentId?: string;
  /** Milliseconds since epoch on the producer's clock (hook process or watcher), when known. */
  readonly sourceAt?: number;
  /** Milliseconds since epoch when the Raio core ingested the record. */
  readonly observedAt: number;
  /** Ingestion order assigned by the core (approximate order within a session). */
  readonly seq: number;
  readonly kind: RaioEventKind;
  /** Project-relative POSIX paths; `outside-project` replaces any path outside the root. */
  readonly paths: readonly string[];
  readonly evidence: RaioEventEvidence;
}

export const OUTSIDE_PROJECT = 'outside-project';
