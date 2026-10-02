import { describe, expect, it } from 'vitest';
import { demoGraph } from './demoProject';
import { connectNodes, NODE_SIZE, WORLD } from './graph';
import type { ArchitectureEdge, ArchitectureNode } from './types';

const node = (id: string, x: number, y: number): ArchitectureNode => ({ id, label: id, kind: 'other', position: { x, y } });
const NODES = [node('a', 200, 170), node('b', 500, 170), node('c', 500, 354), node('d', 800, 170)];
const HALF_W = NODE_SIZE.width / 2;
const HALF_H = NODE_SIZE.height / 2;

/** Points along an edge's path, from start to end. */
const sample = (edge: ArchitectureEdge, count = 64) => Array.from({ length: count + 1 }, (_, i) => edge.path.pointAt(i / count));

const inBox = (n: ArchitectureNode, p: { x: number; y: number }, margin = 0): boolean => Math.abs(p.x - n.position.x) < HALF_W + margin && Math.abs(p.y - n.position.y) < HALF_H + margin;

/** The nodes an edge's line passes over (not counting the two it connects). */
const crossed = (edge: ArchitectureEdge, nodes: readonly ArchitectureNode[], margin = 4): string[] =>
  nodes.filter((n) => n.id !== edge.from && n.id !== edge.to && sample(edge).some((p) => inBox(n, p, margin))).map((n) => n.id);

describe('connectNodes', () => {
  it('makes one edge per distinct link with a stable id, from caller to callee', () => {
    const edges = connectNodes(NODES, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(edges.map((e) => [e.id, e.from, e.to])).toEqual([
      ['a->b', 'a', 'b'],
      ['b->c', 'b', 'c'],
    ]);
  });

  it('never creates an edge to or from a node that is not on the map, a self edge, or a duplicate', () => {
    const edges = connectNodes(NODES, [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'a' }, { from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'b' }]);
    expect(edges.map((e) => e.id)).toEqual(['a->b']);
  });

  it('draws ONE line per unordered pair and keeps the direction of the first link for travel and pulse', () => {
    const edges = connectNodes(NODES, [{ from: 'b', to: 'a' }, { from: 'a', to: 'b' }, { from: 'c', to: 'b' }]);
    expect(edges.map((e) => [e.id, e.from, e.to])).toEqual([
      ['b->a', 'b', 'a'],
      ['c->b', 'c', 'b'],
    ]);
  });

  it('anchors a horizontal link at the middle of the facing box sides, with handles along the x axis', () => {
    const [edge] = connectNodes([NODES[0]!, NODES[3]!], [{ from: 'a', to: 'd' }]);
    const { start, control1, control2, end } = edge!.path;
    expect(start).toEqual({ x: 200 + HALF_W, y: 170 });
    expect(end).toEqual({ x: 800 - HALF_W, y: 170 });
    expect(control1.y).toBe(start.y);
    expect(control2.y).toBe(end.y);
    expect(control1.x).toBeGreaterThan(start.x);
    expect(control2.x).toBeLessThan(end.x);
    const [back] = connectNodes([NODES[0]!, NODES[3]!], [{ from: 'd', to: 'a' }]);
    expect(back!.path.start).toEqual({ x: 800 - HALF_W, y: 170 });
    expect(back!.path.end).toEqual({ x: 200 + HALF_W, y: 170 });
  });

  it('anchors a vertical link at the middle of the facing top/bottom sides, with handles along the y axis', () => {
    const [edge] = connectNodes(NODES, [{ from: 'b', to: 'c' }]);
    const { start, control1, control2, end } = edge!.path;
    expect(start).toEqual({ x: 500, y: 170 + HALF_H });
    expect(end).toEqual({ x: 500, y: 354 - HALF_H });
    expect(control1.x).toBe(start.x);
    expect(control2.x).toBe(end.x);
    const [up] = connectNodes(NODES, [{ from: 'c', to: 'b' }]);
    expect(up!.path.start).toEqual({ x: 500, y: 354 - HALF_H });
    expect(up!.path.end).toEqual({ x: 500, y: 170 + HALF_H });
  });

  it('draws a sideways link as an S between side midpoints and matches the approved concept where it used them', () => {
    const byId = new Map(demoGraph.nodes.map((n) => [n.id, n]));
    const concept = (id: string) => demoGraph.edgeById.get(id)!;
    for (const [id, from, to] of [['frontend-auth', 'frontend', 'auth'], ['api-db', 'api', 'db'], ['config-frontend', 'config', 'frontend']] as const) {
      const [mine] = connectNodes([byId.get(from)!, byId.get(to)!], [{ from, to }]);
      expect(mine!.path.start, id).toEqual(concept(id).path.start);
      expect(mine!.path.end, id).toEqual(concept(id).path.end);
      // The handles lean the same way and about as far as the concept's (within a third of the span).
      const span = Math.hypot(mine!.path.end.x - mine!.path.start.x, mine!.path.end.y - mine!.path.start.y);
      expect(Math.abs(mine!.path.control1.x - concept(id).path.control1.x) + Math.abs(mine!.path.control1.y - concept(id).path.control1.y), id).toBeLessThan(span / 3);
    }
  });

  it('keeps every line inside the world', () => {
    for (const edge of connectNodes(NODES, NODES.flatMap((a) => NODES.map((b) => ({ from: a.id, to: b.id }))))) {
      for (const p of sample(edge)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(WORLD.width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(WORLD.height);
      }
    }
  });

  it('routes around a node that sits between two others instead of drawing over it', () => {
    const row = [node('left', 200, 170), node('middle', 500, 170), node('right', 800, 170)];
    const [edge] = connectNodes(row, [{ from: 'left', to: 'right' }]);
    expect(crossed(edge!, row)).toEqual([]);
    // It still starts and ends on a side midpoint of its own two nodes.
    const sides = [{ x: 200 - HALF_W, y: 170 }, { x: 200 + HALF_W, y: 170 }, { x: 200, y: 170 - HALF_H }, { x: 200, y: 170 + HALF_H }];
    expect(sides).toContainEqual(edge!.path.start);
    const sidesRight = [{ x: 800 - HALF_W, y: 170 }, { x: 800 + HALF_W, y: 170 }, { x: 800, y: 170 - HALF_H }, { x: 800, y: 170 + HALF_H }];
    expect(sidesRight).toContainEqual(edge!.path.end);
  });

  it('routes around a node stacked between two others in a column', () => {
    const column = [node('top', 500, 94), node('middle', 500, 170), node('bottom', 500, 354)];
    const [edge] = connectNodes(column, [{ from: 'top', to: 'bottom' }]);
    expect(crossed(edge!, column)).toEqual([]);
  });

  it('is deterministic', () => {
    const links = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }, { from: 'a', to: 'd' }];
    expect(connectNodes(NODES, links).map((e) => e.path.toSvg())).toEqual(connectNodes(NODES, links).map((e) => e.path.toSvg()));
  });
});
