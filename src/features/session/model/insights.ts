import type { NodeId } from '../../architecture/model/types';
import type { SessionLog } from './events';
import type { RiskKind, ValidationKind, ValidationStatus } from './script';

export interface NodeInsight {
  readonly files: readonly { readonly path: string; readonly change: 'added' | 'modified' | 'deleted' }[];
  readonly reads: number;
  readonly risks: readonly { readonly kind: RiskKind; readonly detail: string }[];
}

export interface SessionInsights {
  readonly byNode: ReadonlyMap<NodeId, NodeInsight>;
  readonly validations: ReadonlyMap<ValidationKind, ValidationStatus>;
  readonly durationMs: number;
  readonly filesChanged: number;
}

/** Aggregates a session log into what the inspector shows. */
export const deriveInsights = (log: SessionLog): SessionInsights => {
  const byNode = new Map<NodeId, { files: Map<string, 'added' | 'modified' | 'deleted'>; reads: number; risks: { kind: RiskKind; detail: string }[] }>();
  const entry = (id: NodeId) => {
    let e = byNode.get(id);
    if (!e) byNode.set(id, (e = { files: new Map(), reads: 0, risks: [] }));
    return e;
  };
  const validations = new Map<ValidationKind, ValidationStatus>();
  let durationMs = 0;
  for (const e of log.events) {
    durationMs = Math.max(durationMs, e.atMs);
    if (e.kind === 'file.write') {
      const files = entry(e.nodeId).files;
      if (!files.has(e.path)) files.set(e.path, e.change);
    } else if (e.kind === 'file.read') entry(e.nodeId).reads++;
    else if (e.kind === 'risk') entry(e.nodeId).risks.push({ kind: e.risk, detail: e.detail });
    else if (e.kind === 'validation') validations.set(e.validation, e.status);
  }
  const result = new Map<NodeId, NodeInsight>();
  let filesChanged = 0;
  for (const [id, e] of byNode) {
    filesChanged += e.files.size;
    result.set(id, { files: [...e.files].map(([path, change]) => ({ path, change })), reads: e.reads, risks: e.risks });
  }
  return { byNode: result, validations, durationMs, filesChanged };
};
