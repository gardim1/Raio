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
