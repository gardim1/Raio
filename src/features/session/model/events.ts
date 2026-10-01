import type { NodeId } from '../../architecture/model/types';
import type { AgentId, RiskKind, ValidationKind, ValidationStatus } from './script';

/**
 * Normalized agent activity, produced by the Claude Code / Codex adapters after
 * file paths have been classified into architecture nodes. Times are ms since session start.
 */
export type AgentEvent =
  | { readonly kind: 'session.start'; readonly atMs: number }
  | { readonly kind: 'file.read'; readonly atMs: number; readonly path: string; readonly nodeId: NodeId }
  | {
      readonly kind: 'file.write';
      readonly atMs: number;
      readonly path: string;
      readonly nodeId: NodeId;
      readonly change: 'added' | 'modified' | 'deleted';
    }
  | { readonly kind: 'risk'; readonly atMs: number; readonly nodeId: NodeId; readonly risk: RiskKind; readonly detail: string }
  | { readonly kind: 'validation'; readonly atMs: number; readonly validation: ValidationKind; readonly status: ValidationStatus }
  | { readonly kind: 'session.end'; readonly atMs: number; readonly outcome: 'completed' | 'failed' | 'interrupted' };

export interface SessionLog {
  readonly id: string;
  readonly agent: AgentId;
  readonly task: string;
  readonly project: string;
  readonly startedAt: string;
  readonly events: readonly AgentEvent[];
}

export const RISK_LABEL: Record<RiskKind, string> = {
  migration: 'Migration detected',
  dependency: 'New dependency added',
  config: 'Environment changed',
  publicApi: 'Public API changed',
  outOfScope: 'Unexpected area touched',
};

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };

/** Formats a millisecond offset as mm:ss. */
export const formatOffset = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
