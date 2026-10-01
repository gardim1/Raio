import type { Vec } from '../../../shared/geometry/vec';
import { NODE_SIZE } from '../../architecture/model/graph';
import type { ArchitectureGraph, ArchitectureNode, NodeId } from '../../architecture/model/types';

/**
 * Where the live orb parks at a system (and how wide it may orbit it) so it never sits on another system,
 * its label or its notice pill. The approved design parks Raio above a system; that stays the default.
 * It moves beside only when something else sits within reach (project layouts put rows ~76 apart).
 * Pure geometry on the node positions, independent of the session: the notice-pill area is reserved under
 * every system at all times, so a later notice never moves or retimes an earlier stop. No randomness.
 */

/** Orb body radius at rest, and the float amplitude that moves it around its parking point. */
const BODY = 11;
const FLOAT = 2.5;
/** Glow radius; only the brighter core (half of it) is kept off other systems' labels. */
const GLOW = 30;
const BODY_CLEARANCE = BODY + FLOAT;
const GLOW_CLEARANCE = GLOW * 0.5;
/** A notice pill hangs under its system (34..74 below the centre in the node frame). */
const PILL_DEPTH = 28;
const WORLD_MARGIN = 14;

export const PARK_ABOVE = 44;
export const PARK_ABOVE_WARNED = 42;
const PARK_SIDE = 90;

export type ParkSide = 'above' | 'left' | 'right';

export interface ParkingSpot {
  readonly side: ParkSide;
  readonly point: Vec;
}

const gapToRect = (p: Vec, c: Vec, halfW: number, halfH: number): number =>
  Math.hypot(Math.max(Math.abs(p.x - c.x) - halfW, 0), Math.max(Math.abs(p.y - c.y) - halfH, 0));

/** Smallest clearance of `p` from every other system (body against the node and its pill area, glow against the label band). */
const clearance = (graph: ArchitectureGraph, own: NodeId, p: Vec): number => {
  let worst = Infinity;
  for (const n of graph.nodes) {
    if (n.id === own) continue;
    const body = gapToRect(p, { x: n.position.x, y: n.position.y + PILL_DEPTH / 2 }, NODE_SIZE.width / 2, NODE_SIZE.height / 2 + PILL_DEPTH) - BODY_CLEARANCE;
    const glow = gapToRect(p, { x: n.position.x, y: n.position.y + 4 }, NODE_SIZE.width / 2, 16) - GLOW_CLEARANCE;
    worst = Math.min(worst, body, glow);
  }
  return worst;
};

const insideWorld = (graph: ArchitectureGraph, p: Vec): boolean =>
  p.x > WORLD_MARGIN && p.x < graph.world.width - WORLD_MARGIN && p.y > WORLD_MARGIN && p.y < graph.world.height - WORLD_MARGIN;

export const parkingSpot = (graph: ArchitectureGraph, node: ArchitectureNode, warned: boolean): ParkingSpot => {
  const { x, y } = node.position;
  const candidates: ParkingSpot[] = [
    { side: 'above', point: { x, y: y - (warned ? PARK_ABOVE_WARNED : PARK_ABOVE) } },
    { side: 'right', point: { x: x + PARK_SIDE, y } },
    { side: 'left', point: { x: x - PARK_SIDE, y } },
  ];
  let best: { spot: ParkingSpot; room: number } | null = null;
  for (const spot of candidates) {
    if (!insideWorld(graph, spot.point)) continue;
    const room = clearance(graph, node.id, spot.point);
    if (room > 0) return spot;
    if (!best || room > best.room) best = { spot, room };
  }
  return best?.spot ?? candidates[0]!;
};

/** The design's orbit ellipse, shrunk only as much as needed to stay clear of neighbouring systems. */
export const orbitRadii = (graph: ArchitectureGraph, node: ArchitectureNode, rx: number, ry: number): { rx: number; ry: number } => {
  const clear = (k: number): boolean => {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      const p = { x: node.position.x + rx * k * Math.cos(a), y: node.position.y + ry * k * Math.sin(a) };
      if (clearance(graph, node.id, p) <= 0) return false;
    }
    return true;
  };
  let k = 1;
  while (k > 0.45 && !clear(k)) k -= 0.05;
  return { rx: rx * k, ry: ry * k };
};
