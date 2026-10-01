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
