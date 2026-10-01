import { createGraph, WORLD } from '../architecture/model/graph';
import type { ArchitectureGraph, ArchitectureNode, SystemKind } from '../architecture/model/types';
import type { PathGroup } from './classifyPath';

const KIND_ORDER: readonly SystemKind[] = ['frontend', 'api', 'auth', 'database', 'payments', 'storage', 'jobs', 'config', 'other'];

/**
 * Where Raio rests between sessions, in world units. Mirrors `HOME` in session/model/compileReplay.ts (a test
 * reads the replay's rest segment, so a drift fails there). Rows below keep clear of it.
 */
export const ORB_REST = { x: 480, y: 262 } as const;

/** Horizontal space available for one row of node centres, and the widest slot a node gets. */
const ROW_WIDTH = 840;
const MAX_SLOT = 300;
/**
 * Row heights in the 1000x520 world, by number of rows. No row crosses the orb's rest band
 * (y 262 ± 66 leaves the glow plus air clear), so a node never sits under the resting orb:
 * rows sit above it, below it, or both. Rows are 76 apart at the tightest (node height + 24 gap).
 */
const ROW_Y: Readonly<Record<1 | 2 | 4, readonly number[]>> = { 1: [170], 2: [170, 354], 4: [94, 170, 354, 430] };

const compareGroups = (a: PathGroup, b: PathGroup): number =>
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId);

const rowCountFor = (count: number): 1 | 2 | 4 => (count <= 3 ? 1 : count <= 8 ? 2 : 4);

/** Splits `count` nodes over `rows` rows as evenly as possible, earlier rows taking the remainder. */
const rowSizes = (count: number, rows: number): number[] => Array.from({ length: rows }, (_, row) => Math.floor(count / rows) + (row < count % rows ? 1 : 0));

/**
 * Deterministic map layout for groups: stable order (kind, then label), row-major with each row centred,
 * and every row clear of the orb's rest position. No randomness and no relayout beyond what the group list implies.
 * The graph has no edges: relationships between groups are not known to the projection.
 */
export const layoutGroups = (groups: readonly PathGroup[]): ArchitectureGraph => {
  const ordered = [...groups].sort(compareGroups);
  const rows = rowCountFor(ordered.length);
  const sizes = rowSizes(ordered.length, rows);
  const slot = Math.min(MAX_SLOT, ROW_WIDTH / Math.max(1, ...sizes));
  const nodes: ArchitectureNode[] = [];
  let index = 0;
  sizes.forEach((inRow, row) => {
    for (let column = 0; column < inRow; column++) {
      const group = ordered[index++]!;
      nodes.push({
        id: group.groupId,
        label: group.label,
        kind: group.kind,
        position: { x: WORLD.width / 2 + (column - (inRow - 1) / 2) * slot, y: ROW_Y[rows][row] ?? WORLD.height / 2 },
      });
    }
  });
  return createGraph(nodes, []);
};
