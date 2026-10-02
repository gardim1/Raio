import { connectNodes, createGraph, type NodeLink, WORLD } from '../architecture/model/graph';
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

/** Layouts and their edge routing are pure in (groups, links), so a refresh with the same map reuses the same graph. */
const MEMO_LIMIT = 16;
const memo = new Map<string, ArchitectureGraph>();

/**
 * Deterministic map layout for groups: stable order (kind, then label), row-major with each row centred,
 * and every row clear of the orb's rest position. No randomness and no relayout beyond what the group list implies.
 * Memoised by (groups, links): the same map returns the same graph object, so nothing is rerouted or recompiled.
 * Edges exist only for the given `links` (static import relations derived elsewhere) between groups on the map;
 * without links the graph has none. Edges never move a node.
 * `reserved` groups take their place in the layout but are not drawn: a group that may appear later (the `Other` of a
 * project map, once a session touches something outside the listing) leaves every other node where it will stay.
 */
export const layoutGroups = (groups: readonly PathGroup[], links: readonly NodeLink[] = [], reserved: readonly PathGroup[] = []): ArchitectureGraph => {
  const ordered = [...groups, ...reserved].sort(compareGroups);
  const held = new Set(reserved.map((g) => g.groupId));
  const key = JSON.stringify([ordered.map((g) => [g.groupId, g.label, g.kind, g.hint ?? '', g.members ?? [], held.has(g.groupId)]), links.map((l) => [l.from, l.to])]);
  const known = memo.get(key);
  if (known) return known;
  const graph = buildLayout(ordered, links, held);
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  memo.set(key, graph);
  return graph;
};

const buildLayout = (ordered: readonly PathGroup[], links: readonly NodeLink[], held: ReadonlySet<string>): ArchitectureGraph => {
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
        ...(group.hint ? { hint: group.hint } : {}),
        ...(group.members ? { members: group.members } : {}),
        position: { x: WORLD.width / 2 + (column - (inRow - 1) / 2) * slot, y: ROW_Y[rows][row] ?? WORLD.height / 2 },
      });
    }
  });
  const drawn = nodes.filter((n) => !held.has(n.id));
  return createGraph(drawn, connectNodes(drawn, links));
};
