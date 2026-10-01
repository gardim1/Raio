import { createGraph, WORLD } from '../architecture/model/graph';
import type { ArchitectureGraph, ArchitectureNode, SystemKind } from '../architecture/model/types';
import type { PathGroup } from './classifyPath';

const KIND_ORDER: readonly SystemKind[] = ['frontend', 'api', 'auth', 'database', 'payments', 'storage', 'jobs', 'config', 'other'];

/** Horizontal space available for one row of node centres, and the widest slot a node gets. */
const ROW_WIDTH = 840;
const MAX_SLOT = 210;
/** Row heights in the 1000x520 world, by number of rows. */
const ROW_Y: Readonly<Record<1 | 2 | 3, readonly number[]>> = { 1: [190], 2: [170, 380], 3: [115, 262, 410] };

const compareGroups = (a: PathGroup, b: PathGroup): number =>
  KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId);

const rowCountFor = (count: number): 1 | 2 | 3 => (count <= 2 ? 1 : count <= 8 ? 2 : 3);

/**
 * Deterministic map layout for groups: stable order (kind, then label), row-major on a grid with
 * each row centred. No randomness and no relayout beyond what the group list implies.
 * The graph has no edges: relationships between groups are not known to the projection.
 */
export const layoutGroups = (groups: readonly PathGroup[]): ArchitectureGraph => {
  const ordered = [...groups].sort(compareGroups);
  const rows = rowCountFor(ordered.length);
  const columns = Math.max(1, Math.ceil(ordered.length / rows));
  const slot = Math.min(MAX_SLOT, ROW_WIDTH / columns);
  const nodes: ArchitectureNode[] = ordered.map((group, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, ordered.length - row * columns);
    const column = index % columns;
    return {
      id: group.groupId,
      label: group.label,
      kind: group.kind,
      position: { x: WORLD.width / 2 + (column - (inRow - 1) / 2) * slot, y: ROW_Y[rows][row] ?? WORLD.height / 2 },
    };
  });
  return createGraph(nodes, []);
};
