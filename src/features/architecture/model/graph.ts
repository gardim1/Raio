import { CubicPath } from '../../../shared/geometry/cubicPath';
import type { Vec } from '../../../shared/geometry/vec';
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode, EdgeId, NodeId } from './types';

export const WORLD = { width: 1000, height: 520 } as const;
export const NODE_SIZE = { width: 132, height: 52 } as const;

/** Builds an immutable graph with O(1) lookups. */
export const createGraph = (nodes: readonly ArchitectureNode[], edges: readonly ArchitectureEdge[]): ArchitectureGraph => ({
  world: WORLD,
  nodes,
  edges,
  nodeById: new Map(nodes.map((n) => [n.id, n])),
  edgeById: new Map(edges.map((e) => [e.id, e])),
});

/** Finds the edge connecting two nodes in the given direction, if any. */
export const findEdge = (graph: ArchitectureGraph, from: NodeId, to: NodeId): ArchitectureEdge | undefined =>
  graph.edges.find((e) => e.from === from && e.to === to);

/** Finds an edge between two nodes in either direction, reporting whether traversal runs backwards. */
export const findLink = (
  graph: ArchitectureGraph,
  a: NodeId,
  b: NodeId,
): { readonly edge: ArchitectureEdge; readonly reversed: boolean } | undefined => {
  const forward = findEdge(graph, a, b);
  if (forward) return { edge: forward, reversed: false };
  const backward = findEdge(graph, b, a);
  return backward ? { edge: backward, reversed: true } : undefined;
};

export const requireNode = (graph: ArchitectureGraph, id: NodeId): ArchitectureNode => {
  const node = graph.nodeById.get(id);
  if (!node) throw new Error(`Unknown node: ${id}`);
  return node;
};

export const requireEdge = (graph: ArchitectureGraph, id: EdgeId): ArchitectureEdge => {
  const edge = graph.edgeById.get(id);
  if (!edge) throw new Error(`Unknown edge: ${id}`);
  return edge;
};

/** A relationship between two nodes, caller to callee. */
export interface NodeLink {
  readonly from: NodeId;
  readonly to: NodeId;
}

/*
 * Edge geometry follows the approved concept (raio-engine.js): an S-shaped cubic anchored at the middle of the
 * facing box sides, its handles parallel to the axis the line mostly runs along. When another node would sit
 * under the line, the line keeps its two end nodes and side-midpoint anchors but leaves and arrives by sides with room.
 */
type Side = 'left' | 'right' | 'top' | 'bottom';

const HANDLE = 0.54; // handle length as a share of the distance along the main axis (the concept uses 0.52-0.56)
const SAMPLES = 48;
const CLEARANCE = 4; // air kept between a line and a node it passes
const BULGES = [24, 44, 64, 88, 112, 140, 172, 208, 248, 300] as const;
/** Order in which sides are tried when a line has to go around: stable, so a layout always draws the same. */
const SIDES: readonly Side[] = ['right', 'left', 'bottom', 'top'];
const OUTWARD: Readonly<Record<Side, Vec>> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

const anchorOf = (node: ArchitectureNode, side: Side): Vec => {
  const { x, y } = node.position;
  return side === 'left' ? { x: x - NODE_SIZE.width / 2, y } : side === 'right' ? { x: x + NODE_SIZE.width / 2, y } : side === 'top' ? { x, y: y - NODE_SIZE.height / 2 } : { x, y: y + NODE_SIZE.height / 2 };
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const rounded = (v: Vec): Vec => ({ x: round2(v.x), y: round2(v.y) });
const cubic = (a: Vec, b: Vec, c: Vec, d: Vec): CubicPath => new CubicPath(rounded(a), rounded(b), rounded(c), rounded(d));

/** The S between the facing sides along `axis`, or null when the boxes overlap along it (no facing sides). */
const sCurve = (from: ArchitectureNode, to: ArchitectureNode, axis: 'x' | 'y'): CubicPath | null => {
  const delta = to.position[axis] - from.position[axis];
  const box = axis === 'x' ? NODE_SIZE.width : NODE_SIZE.height;
  if (Math.abs(delta) <= box) return null;
  const positive = delta > 0;
  const sides: readonly [Side, Side] = axis === 'x' ? (positive ? ['right', 'left'] : ['left', 'right']) : positive ? ['bottom', 'top'] : ['top', 'bottom'];
  const start = anchorOf(from, sides[0]);
  const end = anchorOf(to, sides[1]);
  const handle = Math.abs(end[axis] - start[axis]) * HANDLE * Math.sign(delta);
  const c1 = axis === 'x' ? { x: start.x + handle, y: start.y } : { x: start.x, y: start.y + handle };
  const c2 = axis === 'x' ? { x: end.x - handle, y: end.y } : { x: end.x, y: end.y - handle };
  return cubic(start, c1, c2, end);
};

/** A line that leaves `from` by one side and meets `to` at another (or the same), swinging out by `bulge`, to go around whatever sits between them. */
const detour = (from: ArchitectureNode, to: ArchitectureNode, out: Side, into: Side, bulge: number): CubicPath => {
  const start = anchorOf(from, out);
  const end = anchorOf(to, into);
  const a = OUTWARD[out];
  const b = OUTWARD[into];
  return cubic(start, { x: start.x + a.x * bulge, y: start.y + a.y * bulge }, { x: end.x + b.x * bulge, y: end.y + b.y * bulge }, end);
};

const overBox = (node: ArchitectureNode, p: Vec, margin: number): boolean =>
  Math.abs(p.x - node.position.x) < NODE_SIZE.width / 2 + margin && Math.abs(p.y - node.position.y) < NODE_SIZE.height / 2 + margin;

/** True when the line stays in the world and passes over no node other than its own two (those only near their ends are ignored). */
const isClear = (path: CubicPath, from: ArchitectureNode, to: ArchitectureNode, others: readonly ArchitectureNode[]): boolean => {
  for (let i = 0; i <= SAMPLES; i++) {
    const p = path.pointAt(i / SAMPLES);
    if (p.x < 0 || p.x > WORLD.width || p.y < 0 || p.y > WORLD.height) return false;
    if (others.some((n) => overBox(n, p, CLEARANCE))) return false;
    // A line that doubles back over its own boxes is not clear either (the end samples sit on their borders).
    if (i > 1 && i < SAMPLES - 1 && (overBox(from, p, -1) || overBox(to, p, -1))) return false;
  }
  return true;
};

/** The line for one link: the concept's S along the main axis, else the other axis, else around by the first side with room. */
const routeBetween = (from: ArchitectureNode, to: ArchitectureNode, others: readonly ArchitectureNode[]): CubicPath | null => {
  const dx = to.position.x - from.position.x;
  const dy = to.position.y - from.position.y;
  if (dx === 0 && dy === 0) return null;
  const axes: ('x' | 'y')[] = Math.abs(dx) >= Math.abs(dy) ? ['x', 'y'] : ['y', 'x'];
  const candidates = axes.map((axis) => sCurve(from, to, axis)).filter((c): c is CubicPath => c !== null);
  for (const path of candidates) if (isClear(path, from, to, others)) return path;
  for (const bulge of BULGES) {
    for (const out of SIDES) {
      for (const into of SIDES) {
        const path = detour(from, to, out, into, bulge);
        if (isClear(path, from, to, others)) return path;
      }
    }
  }
  // No clear way round (a crowded map): keep the concept's line rather than dropping a relationship that exists.
  return candidates[0] ?? detour(from, to, dy >= 0 ? 'bottom' : 'top', dy >= 0 ? 'bottom' : 'top', BULGES[0]);
};

/**
 * Edges for the given links. A link whose nodes are not both on the map, a self link and a repeated link produce
 * nothing: edges exist only between nodes that exist, and ONE line is drawn per unordered pair of nodes. The edge
 * keeps the direction of the first link of the pair (caller to callee), which is what travel and pulses follow.
 */
export const connectNodes = (nodes: readonly ArchitectureNode[], links: readonly NodeLink[]): ArchitectureEdge[] => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: ArchitectureEdge[] = [];
  const drawn = new Set<string>();
  for (const link of links) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to || link.from === link.to) continue;
    const pair = link.from < link.to ? `${link.from}\u0000${link.to}` : `${link.to}\u0000${link.from}`;
    if (drawn.has(pair)) continue;
    const path = routeBetween(from, to, nodes.filter((n) => n.id !== from.id && n.id !== to.id));
    if (!path) continue;
    drawn.add(pair);
    edges.push({ id: `${link.from}->${link.to}`, from: link.from, to: link.to, path });
  }
  return edges;
};
