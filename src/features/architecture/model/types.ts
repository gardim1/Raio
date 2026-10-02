import type { CubicPath } from '../../../shared/geometry/cubicPath';
import type { Vec } from '../../../shared/geometry/vec';

export type NodeId = string;
export type EdgeId = string;

/** Semantic category of a system. Drives default icons/labels; never colour. */
export type SystemKind = 'frontend' | 'api' | 'auth' | 'database' | 'payments' | 'storage' | 'config' | 'jobs' | 'other';

/** One box on the architecture map. Positions are node centres in world units. */
export interface ArchitectureNode {
  readonly id: NodeId;
  readonly label: string;
  readonly kind: SystemKind;
  /** Technology the project's manifests name for this area (`API · Express`). A heuristic; absent when none is named. */
  readonly hint?: string;
  /** Only on `Other`: the areas a session touched that did not fit among the 12 largest and are shown inside it. */
  readonly members?: readonly string[];
  readonly position: Vec;
}

/** A directed relationship (caller → callee). */
export interface ArchitectureEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly path: CubicPath;
}

export interface ArchitectureGraph {
  readonly world: { readonly width: number; readonly height: number };
  readonly nodes: readonly ArchitectureNode[];
  readonly edges: readonly ArchitectureEdge[];
  readonly nodeById: ReadonlyMap<NodeId, ArchitectureNode>;
  readonly edgeById: ReadonlyMap<EdgeId, ArchitectureEdge>;
}
