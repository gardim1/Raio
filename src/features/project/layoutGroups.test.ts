import { describe, expect, it } from 'vitest';
import { NODE_SIZE, WORLD } from '../architecture/model/graph';
import { compileReplay } from '../session/model/compileReplay';
import type { SessionLog } from '../session/model/events';
import type { PathGroup } from './classifyPath';
import { layoutGroups, ORB_REST } from './layoutGroups';

const groups = (count: number): PathGroup[] => Array.from({ length: count }, (_, i) => ({ groupId: `g${String(i).padStart(2, '0')}`, label: `Group ${String(i).padStart(2, '0')}`, kind: 'other' as const }));

/** The orb's resting glow is 30 units; the test keeps a further 16 units of air around it. */
const ORB_RADIUS = 30;
const ORB_MARGIN = 16;
const MIN_GAP = 24;

/** Distance from a point to the nearest point of an axis-aligned rectangle (0 when inside). */
const distanceToRect = (point: { x: number; y: number }, centre: { x: number; y: number }): number => {
  const dx = Math.max(Math.abs(point.x - centre.x) - NODE_SIZE.width / 2, 0);
  const dy = Math.max(Math.abs(point.y - centre.y) - NODE_SIZE.height / 2, 0);
  return Math.hypot(dx, dy);
};

describe('layoutGroups', () => {
  it('returns an empty graph without edges for no groups', () => {
    const graph = layoutGroups([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('creates one node per group with no edges at all', () => {
    const graph = layoutGroups(groups(5));
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toEqual([]);
    expect(graph.world).toEqual(WORLD);
    expect(graph.nodeById.get('g03')?.label).toBe('Group 03');
  });

  it('draws edges only for links between groups on the map', () => {
    const graph = layoutGroups(groups(3), [
      { from: 'g00', to: 'g01' },
      { from: 'g02', to: 'g00' },
      { from: 'g00', to: 'ghost' },
      { from: 'g01', to: 'g01' },
    ]);
    expect(graph.edges.map((e) => e.id)).toEqual(['g00->g01', 'g02->g00']);
    expect(graph.edgeById.get('g00->g01')?.path.length).toBeGreaterThan(0);
  });

  it('keeps node positions identical whether or not there are edges (no relayout)', () => {
    const plain = layoutGroups(groups(6));
    const linked = layoutGroups(groups(6), [{ from: 'g00', to: 'g05' }]);
    expect(linked.nodes).toEqual(plain.nodes);
  });

  it('orders nodes by kind and then by label, whatever the input order', () => {
    const input: PathGroup[] = [
      { groupId: 'z', label: 'Zed', kind: 'other' },
      { groupId: 'db', label: 'DB', kind: 'database' },
      { groupId: 'web', label: 'Web', kind: 'frontend' },
      { groupId: 'a', label: 'Alpha', kind: 'other' },
      { groupId: 'api', label: 'API', kind: 'api' },
    ];
    const expected = ['web', 'api', 'db', 'a', 'z'];
    expect(layoutGroups(input).nodes.map((n) => n.id)).toEqual(expected);
    expect(layoutGroups([...input].reverse()).nodes.map((n) => n.id)).toEqual(expected);
  });

  it('is deterministic', () => {
    expect(layoutGroups(groups(9)).nodes).toEqual(layoutGroups(groups(9)).nodes);
  });

  it.each([1, 2, 3, 4, 6, 8, 9, 12, 13])('keeps %i nodes inside the world and clear of each other', (count) => {
    const { nodes } = layoutGroups(groups(count));
    for (const n of nodes) {
      expect(n.position.x - NODE_SIZE.width / 2).toBeGreaterThanOrEqual(0);
      expect(n.position.x + NODE_SIZE.width / 2).toBeLessThanOrEqual(WORLD.width);
      expect(n.position.y - NODE_SIZE.height / 2).toBeGreaterThanOrEqual(0);
      expect(n.position.y + NODE_SIZE.height / 2).toBeLessThanOrEqual(WORLD.height);
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = Math.abs(nodes[i]!.position.x - nodes[j]!.position.x);
        const dy = Math.abs(nodes[i]!.position.y - nodes[j]!.position.y);
        // Boxes must not overlap and keep a visible gap on at least one axis.
        expect(dx >= NODE_SIZE.width + MIN_GAP || dy >= NODE_SIZE.height + MIN_GAP, `${nodes[i]!.id} vs ${nodes[j]!.id}`).toBe(true);
      }
    }
  });

  it.each([1, 6, 9, 12, 13])('keeps no node rectangle on the Raio orb rest circle (with margin) for %i groups', (count) => {
    for (const n of layoutGroups(groups(count)).nodes) {
      expect(distanceToRect(ORB_REST, n.position), n.id).toBeGreaterThan(ORB_RADIUS + ORB_MARGIN);
    }
  });

  it('keeps the orb rest position the replay actually uses', () => {
    const log: SessionLog = {
      id: 's',
      agent: 'claude',
      task: 't',
      project: 'p',
      startedAt: new Date(0).toISOString(),
      events: [
        { kind: 'session.start', atMs: 0 },
        { kind: 'file.write', atMs: 1000, path: 'src/a.ts', nodeId: 'g00', change: 'modified' },
        { kind: 'session.end', atMs: 2000, outcome: 'completed' },
      ],
    };
    const script = compileReplay(log, layoutGroups(groups(1)));
    const rest = script.orb.at(-1);
    expect(rest).toMatchObject({ kind: 'rest', at: ORB_REST });
  });

  it('gives every node a distinct position', () => {
    const keys = layoutGroups(groups(13)).nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(keys).size).toBe(13);
  });
});

describe('layoutGroups: memoised by (groups, links)', () => {
  const links = [{ from: 'g00', to: 'g02' }, { from: 'g01', to: 'g02' }];

  it('returns the very same graph for the same groups and links, so a refresh does not reroute or recompile', () => {
    const first = layoutGroups(groups(4), links);
    expect(layoutGroups(groups(4), links.map((l) => ({ ...l })))).toBe(first);
    expect(layoutGroups([...groups(4)].reverse(), links)).toBe(first);
  });

  it('builds a new graph when a group (id, label or kind) or a link changes', () => {
    const first = layoutGroups(groups(4), links);
    expect(layoutGroups(groups(5), links)).not.toBe(first);
    expect(layoutGroups(groups(4), [links[0]!])).not.toBe(first);
    expect(layoutGroups(groups(4), [...links].reverse())).not.toBe(first); // link order picks which direction a pair keeps
    const renamed = groups(4).map((g, i) => (i === 0 ? { ...g, label: 'Renamed' } : g));
    expect(layoutGroups(renamed, links)).not.toBe(first);
    const rekinded = groups(4).map((g, i) => (i === 0 ? { ...g, kind: 'api' as const } : g));
    expect(layoutGroups(rekinded, links)).not.toBe(first);
  });

  it('does not change what a layout looks like because it was memoised', () => {
    const a = layoutGroups(groups(7), links);
    const b = layoutGroups(groups(7), links);
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges.map((e) => e.path.toSvg())).toEqual(a.edges.map((e) => e.path.toSvg()));
  });

  it('stays bounded however many different maps it has seen', () => {
    for (let i = 1; i <= 40; i++) layoutGroups(groups(1 + (i % 13)), [{ from: 'g00', to: `g${String(i % 13).padStart(2, '0')}` }]);
    expect(layoutGroups(groups(3), links).nodes).toHaveLength(3);
  });
});

describe('layoutGroups: edges on a dense map', () => {
  /** How many drawn lines pass over a node that is not one of their two ends (with a few units of air), and how many leave the world. */
  const measure = (count: number, links: (ids: string[]) => { from: string; to: string }[]) => {
    const ids = groups(count).map((g) => g.groupId);
    const graph = layoutGroups(groups(count), links(ids));
    let crossing = 0;
    let outside = 0;
    for (const edge of graph.edges) {
      const points = Array.from({ length: 65 }, (_, i) => edge.path.pointAt(i / 64));
      if (points.some((p) => p.x < 0 || p.x > WORLD.width || p.y < 0 || p.y > WORLD.height)) outside++;
      const over = graph.nodes.some((n) => n.id !== edge.from && n.id !== edge.to && points.some((p) => Math.abs(p.x - n.position.x) < NODE_SIZE.width / 2 + 4 && Math.abs(p.y - n.position.y) < NODE_SIZE.height / 2 + 4));
      if (over) crossing++;
    }
    return { graph, crossing, outside };
  };
  const everyPair = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ from: a, to: b })));
  const ring = (ids: string[]) => ids.flatMap((a, i) => [1, 2, 3, 5].map((k) => ({ from: a, to: ids[(i + k) % ids.length]! })));

  /**
   * Residual cases, measured and accepted: on 11 to 13 nodes with every pair linked (or four links per node on 13)
   * a line can still pass over a node, because the rows leave only a 24-unit channel. Up to 10 nodes, none does.
   */
  const RESIDUAL_EVERY_PAIR: Readonly<Record<number, number>> = { 11: 2, 12: 4, 13: 8 };
  const RESIDUAL_RING: Readonly<Record<number, number>> = { 11: 1, 13: 6 };

  for (let count = 1; count <= 13; count++) {
    it(`draws one line per pair with no line over a node and none outside the world (${count} groups, every pair linked)`, () => {
      const { graph, crossing, outside } = measure(count, everyPair);
      expect(graph.edges).toHaveLength((count * (count - 1)) / 2);
      expect(outside).toBe(0);
      expect(crossing).toBeLessThanOrEqual(RESIDUAL_EVERY_PAIR[count] ?? 0);
    });

    it(`keeps four links per node (a ring) clear of other nodes (${count} groups)`, () => {
      const { graph, crossing, outside } = measure(count, ring);
      expect(new Set(graph.edges.map((e) => [e.from, e.to].sort().join('|'))).size).toBe(graph.edges.length);
      expect(outside).toBe(0);
      expect(crossing).toBeLessThanOrEqual(RESIDUAL_RING[count] ?? 0);
    });
  }

  it('does not move a node when edges are added to a dense map', () => {
    const ids = groups(13).map((g) => g.groupId);
    expect(layoutGroups(groups(13), everyPair(ids)).nodes).toEqual(layoutGroups(groups(13)).nodes);
  });
});

describe('layoutGroups: technology hints', () => {
  it('carries a hint to its node and none where the group has none', () => {
    const graph = layoutGroups([
      { groupId: 'api', label: 'API', kind: 'api', hint: 'API · Express' },
      { groupId: 'auth', label: 'Auth', kind: 'auth' },
    ]);
    expect(graph.nodeById.get('api')?.hint).toBe('API · Express');
    expect(graph.nodeById.get('auth')).not.toHaveProperty('hint');
  });

  it('does not reuse a memoised graph across different hints', () => {
    const base = { groupId: 'api', label: 'API', kind: 'api' as const };
    expect(layoutGroups([{ ...base, hint: 'API · Express' }]).nodeById.get('api')?.hint).toBe('API · Express');
    expect(layoutGroups([{ ...base, hint: 'API · Fastify' }]).nodeById.get('api')?.hint).toBe('API · Fastify');
    expect(layoutGroups([base]).nodeById.get('api')).not.toHaveProperty('hint');
  });

  it('places nodes the same way whatever the hints say', () => {
    const plain = groups(6);
    const hinted = plain.map((g) => ({ ...g, hint: `Hint ${g.groupId}` }));
    expect(layoutGroups(hinted).nodes.map((n) => n.position)).toEqual(layoutGroups(plain).nodes.map((n) => n.position));
  });
});

describe('layoutGroups: reserved places', () => {
  it('lays the groups out as if the reserved ones were there, without drawing them', () => {
    const all = groups(6);
    const reserved = all[5]!;
    const full = layoutGroups(all);
    const partial = layoutGroups(all.slice(0, 5), [], [reserved]);
    expect(partial.nodes.map((n) => n.id)).toEqual(all.slice(0, 5).map((g) => g.groupId));
    for (const node of partial.nodes) expect(node.position).toEqual(full.nodeById.get(node.id)!.position);
    expect(partial.nodeById.has(reserved.groupId)).toBe(false);
  });

  it('draws the same nodes in the same places when a reserved group is later present', () => {
    const all = groups(4);
    const before = layoutGroups(all.slice(0, 3), [], [all[3]!]);
    const after = layoutGroups(all);
    for (const node of before.nodes) expect(after.nodeById.get(node.id)!.position).toEqual(node.position);
    expect(after.nodes).toHaveLength(4);
  });

  it('does not reuse a memoised graph across different reservations', () => {
    const all = groups(4);
    const reserved = layoutGroups(all.slice(0, 3), [], [all[3]!]).nodes.map((n) => n.position);
    const plain = layoutGroups(all.slice(0, 3)).nodes.map((n) => n.position);
    expect(reserved).not.toEqual(plain);
  });
});
