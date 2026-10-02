import { describe, expect, it } from 'vitest';
import { tokens } from '../../tokens';
import type { RaioEvent, RaioEventKind } from '../ingest/raioEvent';
import { compileReplay } from '../session/model/compileReplay';
import { evaluateFrame } from '../session/model/evaluateFrame';
import { HEURISTIC_NOTE } from './classifyPath';
import type { ProjectImports } from './importEdges';
import type { ProjectInventory } from './projectInventory';
import { projectSessionDetailed } from './projectSession';

const PROJECT = { id: 'p1', name: 'acme-mini' };
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

let seq = 0;
const ev = (kind: RaioEventKind, atSec: number, paths: string[] = [], evidence: RaioEvent['evidence'] = {}, extra: Partial<RaioEvent> = {}): RaioEvent => {
  seq += 1;
  return {
    schema: 1,
    id: `i${seq}`,
    source: 'claude-hook',
    provenance: 'agent-reported',
    attribution: 'session',
    projectId: PROJECT.id,
    sessionId: 's1',
    agent: 'claude',
    sourceAt: T0 + atSec * 1000,
    observedAt: T0 + atSec * 1000 + 40,
    seq,
    kind,
    paths,
    evidence,
    ...extra,
  };
};
const started = (atSec = 0) => ev('session.started', atSec, [], { detail: 'startup' });
const read = (atSec: number, path: string) => ev('file.inspected', atSec, [path], { toolName: 'Read' });
const edit = (atSec: number, path: string, change: 'added' | 'modified' = 'modified') => ev('file.edit.reported', atSec, [path], { toolName: 'Write', change });

const inventoryOf = (files: readonly string[], manifests: ProjectInventory['manifests'] = [], extra: Partial<ProjectInventory> = {}): ProjectInventory => ({
  files,
  truncated: false,
  skipped: 0,
  scannedAtMs: 1,
  manifests,
  ...extra,
});
const scanOf = (files: Record<string, string[]>): ProjectImports => ({
  files: Object.entries(files).map(([path, specifiers]) => ({ path, specifiers })),
  truncated: false,
  skipped: 0,
  scannedAtMs: 1,
});
const run = (events: readonly RaioEvent[], inventory: ProjectInventory | null | undefined, imports?: ProjectImports | null, inventoryStale = false) => {
  const projected = projectSessionDetailed(PROJECT, events, undefined, imports, false, inventory, inventoryStale);
  if (!projected) throw new Error('expected a projection');
  return projected;
};
const ids = (graph: { readonly nodes: readonly { readonly id: string }[] }) => graph.nodes.map((n) => n.id).sort();

const INVENTORY = inventoryOf(
  ['package.json', 'README.md', 'src/auth/login.ts', 'src/auth/session.ts', 'src/api/users.ts', 'src/web/app.ts', 'src/web/page.tsx', 'src/payments/charge.ts', 'src/storage/s3.ts'],
  [{ path: 'package.json', kind: 'npm', facts: { dependencies: ['express', 'react'] } }],
);
const SESSION = [started(0), edit(1, 'src/auth/login.ts', 'added'), edit(2, 'src/api/users.ts')];

describe('projectSession: whole-project inventory', () => {
  it('maps the whole project, not only what the session touched', () => {
    const { snapshot } = run(SESSION, INVENTORY);
    expect(ids(snapshot.graph)).toEqual(['api', 'auth', 'config', 'payments', 'storage', 'web']);
  });

  it('keeps the session-only map and wording when there is no inventory', () => {
    for (const inventory of [undefined, null]) {
      const { snapshot, insights } = run(SESSION, inventory);
      expect(ids(snapshot.graph)).toEqual(['api', 'auth']);
      expect(insights.note).toBe(HEURISTIC_NOTE);
      expect(insights.technologies).toBeUndefined();
    }
  });

  it('shows the areas the session never touched dimmed, with the existing dormant look', () => {
    const { snapshot } = run(SESSION, INVENTORY);
    const script = compileReplay(snapshot.log, snapshot.graph);
    expect(script.nodes.map((c) => c.nodeId).sort()).toEqual(['api', 'auth']);
    const frame = evaluateFrame(script, snapshot.graph, 0);
    for (const id of ['web', 'payments', 'storage', 'config']) {
      expect(frame.nodes.get(id), id).toMatchObject({ touched: false, activation: 0, opacity: tokens.opacity.dormantNode });
    }
    expect(frame.nodes.get('auth')?.touched).toBe(true);
  });

  it('hangs the technology hints from the manifests on the nodes, and none where no manifest names one', () => {
    const { snapshot } = run(SESSION, INVENTORY);
    const hint = (id: string) => snapshot.graph.nodeById.get(id)?.hint;
    expect(hint('api')).toBe('API · Express');
    expect(hint('web')).toBe('Frontend · React');
    expect(hint('auth')).toBeUndefined();
    expect(hint('payments')).toBeUndefined();
  });

  it('says in the copy that areas are guessed from folders and manifests, and lists the manifest technologies as names apart from it', () => {
    const { insights } = run(SESSION, INVENTORY);
    expect(insights.note).toMatch(/^Areas are a heuristic guess from folders and manifests, not verified dependencies\./);
    expect(insights.note).toContain('Relationships between areas are unknown.');
    expect(insights.note).not.toContain('Technologies');
    expect(insights.technologies).toEqual(['Frontend · React', 'API · Express']);
  });

  it('says the areas are as of the last listing when a later relisting failed', () => {
    expect(run(SESSION, INVENTORY, null, true).insights.note).toContain('The latest relisting failed, so these areas are as of the last listing.');
    expect(run(SESSION, INVENTORY, null, false).insights.note).not.toContain('relisting');
    expect(run(SESSION, null, null, true).insights.note).toBe(HEURISTIC_NOTE);
  });

  it('keeps the heuristic wording once imports exist, and flags a partial listing', () => {
    const { insights } = run(SESSION, { ...INVENTORY, truncated: true, skipped: 3 }, scanOf({ 'src/api/users.ts': ['../auth/login'], 'src/auth/login.ts': [] }));
    expect(insights.note).toContain('Areas are a heuristic guess from folders and manifests, not verified dependencies. Relationships: static imports between areas (heuristic).');
    expect(insights.note).toContain('The project listing was partial, so some areas may be missing.');
    expect(insights.note).toContain('3 files or folders not listed (large, unreadable or online-only).');
  });

  it('keeps node positions stable across sessions of the same project', () => {
    const positions = (events: readonly RaioEvent[]) => Object.fromEntries(run(events, INVENTORY).snapshot.graph.nodes.map((n) => [n.id, n.position]));
    const other = [started(0), edit(1, 'src/payments/charge.ts'), read(2, 'src/web/app.ts')];
    expect(positions(other)).toEqual(positions(SESSION));
  });

  it('is deterministic for the same events and inventory', () => {
    const a = run(SESSION, INVENTORY);
    const b = run(SESSION, { ...INVENTORY, files: [...INVENTORY.files].reverse() });
    expect(b.snapshot.graph.nodes).toEqual(a.snapshot.graph.nodes);
  });

  describe('with more than 12 areas', () => {
    const files = Array.from({ length: 16 }, (_, i) => Array.from({ length: 16 - i }, (_, n) => `dir${String(i).padStart(2, '0')}/f${n}.ts`)).flat();
    const big = inventoryOf(files);

    it('shows an area the session touched but is not among the largest 12 inside Other, marked touched and listing it', () => {
      const { snapshot } = run([started(0), edit(1, 'dir15/f0.ts', 'added'), edit(2, 'dir14/f0.ts')], big);
      expect(snapshot.graph.nodes).toHaveLength(13);
      expect(ids(snapshot.graph)).not.toContain('dir15');
      expect(snapshot.graph.nodeById.get('merged-other')?.members).toEqual(['Dir14', 'Dir15']);
      expect(snapshot.log.events.find((e) => e.kind === 'file.write')).toMatchObject({ nodeId: 'merged-other' });
      const script = compileReplay(snapshot.log, snapshot.graph);
      expect(script.nodes.map((c) => c.nodeId)).toEqual(['merged-other']);
      expect(evaluateFrame(script, snapshot.graph, 0).nodes.get('merged-other')?.touched).toBe(true);
    });

    it('does not mark Other as touched, nor list anything in it, when the session touched only the largest areas', () => {
      const { snapshot } = run([started(0), edit(1, 'dir00/f0.ts')], big);
      const script = compileReplay(snapshot.log, snapshot.graph);
      expect(script.nodes.map((c) => c.nodeId)).toEqual(['dir00']);
      expect(snapshot.graph.nodeById.get('merged-other')).not.toHaveProperty('members');
    });

    it('never moves a node between sessions: whatever is touched, the 12 largest and Other stay where they are', () => {
      const positions = (events: readonly RaioEvent[]) => Object.fromEntries(run(events, big).snapshot.graph.nodes.map((n) => [n.id, n.position]));
      const none = positions([started(0), read(1, 'dir00/f0.ts')]);
      expect(positions([started(0), edit(1, 'dir15/f0.ts'), edit(2, 'dir14/f1.ts')])).toEqual(none);
      expect(positions([started(0), edit(1, 'dir07/f0.ts'), edit(2, 'dir13/f0.ts'), edit(3, 'brandnew/x.ts')])).toEqual(none);
    });

    it('assigns events and disk changes in folded areas to Other', () => {
      const events = [started(0), edit(1, 'dir15/f0.ts'), ev('file.changed', 2, ['dir14/f0.ts'], {}, { source: 'fs-watch', provenance: 'filesystem-observed', attribution: 'unassigned', agent: 'unknown', sessionId: undefined })];
      const { insights } = run(events, big);
      expect(insights.unassigned).toEqual([expect.objectContaining({ path: 'dir14/f0.ts', groupId: 'merged-other', groupLabel: 'Other' })]);
    });
  });

  it('names unassigned changes after the areas of the map, not the folder-name guess', () => {
    const inventory = inventoryOf(['package.json', 'libs/core/index.ts', 'libs/ui/button.ts'], [{ path: 'package.json', kind: 'npm', facts: { workspaces: ['libs/*'] } }]);
    const change = ev('file.changed', 2, ['libs/ui/button.ts'], {}, { source: 'fs-watch', provenance: 'filesystem-observed', attribution: 'unassigned', agent: 'unknown', sessionId: undefined });
    const { insights } = run([started(0), edit(1, 'libs/core/index.ts'), change], inventory);
    expect(insights.unassigned).toEqual([expect.objectContaining({ path: 'libs/ui/button.ts', groupId: 'libs/ui' })]);
  });

  it('shows a touched file the scan did not list inside Other, touched and listed, instead of adding an area', () => {
    const { snapshot } = run([started(0), edit(1, 'src/newarea/a.ts', 'added'), edit(2, 'README.md')], INVENTORY);
    expect(ids(snapshot.graph)).not.toContain('newarea');
    expect(snapshot.graph.nodeById.get('merged-other')?.members).toEqual(['Newarea', 'Project root']);
    expect(compileReplay(snapshot.log, snapshot.graph).nodes.map((c) => c.nodeId)).toEqual(['merged-other']);
  });

  it('keeps the node set and positions with 12 areas or fewer whatever the session touches outside the listing', () => {
    const nodesOf = (events: readonly RaioEvent[]) => run(events, INVENTORY).snapshot.graph.nodes;
    const positions = (events: readonly RaioEvent[]) => Object.fromEntries(nodesOf(events).map((n) => [n.id, n.position]));
    const listed = positions([started(0), edit(1, 'src/auth/login.ts')]);
    const readme = positions([started(0), edit(1, 'README.md')]);
    const both = positions([started(0), edit(1, 'README.md'), edit(2, 'brandnew/x.ts'), edit(3, 'src/auth/login.ts')]);
    const folder = positions([started(0), edit(1, 'brandnew/x.ts')]);
    // Other appears only once the session touches something the listing does not hold, and then always in the same place.
    expect(Object.keys(readme).sort()).toEqual(Object.keys(both).sort());
    expect(Object.keys(folder).sort()).toEqual(Object.keys(both).sort());
    expect(readme).toEqual(both);
    expect(folder).toEqual(both);
    expect(Object.keys(both).sort()).toEqual([...Object.keys(listed), 'merged-other'].sort());
    // Nothing else moves: the areas of the listing stay exactly where they were without it.
    for (const id of Object.keys(listed)) expect(both[id], id).toEqual(listed[id]);
  });

  it('assigns session events to the same areas the map shows (workspace packages from the manifests)', () => {
    const inventory = inventoryOf(['package.json', 'libs/core/index.ts', 'libs/ui/button.ts'], [{ path: 'package.json', kind: 'npm', facts: { workspaces: ['libs/*'] } }]);
    const { snapshot } = run([started(0), edit(1, 'libs/core/index.ts')], inventory);
    expect(ids(snapshot.graph)).toEqual(['config', 'libs/core', 'libs/ui']);
    expect(snapshot.log.events.find((e) => e.kind === 'file.write')).toMatchObject({ nodeId: 'libs/core' });
  });

  it('draws static import edges between any areas on the map, using the same areas as the nodes', () => {
    const inventory = inventoryOf(['package.json', 'libs/core/index.ts', 'libs/ui/button.ts', 'src/web/app.ts'], [{ path: 'package.json', kind: 'npm', facts: { workspaces: ['libs/*'] } }]);
    const imports = scanOf({ 'libs/ui/button.ts': ['../core/index'], 'libs/core/index.ts': [], 'src/web/app.ts': ['../../libs/ui/button'] });
    const { snapshot, insights } = run([started(0), edit(1, 'libs/core/index.ts')], inventory, imports);
    expect(snapshot.graph.edges.map((e) => e.id).sort()).toEqual(['libs/ui->libs/core', 'web->libs/ui']);
    expect(insights.relationships).toMatchObject({ kind: 'static-imports', edges: 2, imports: 2 });
  });

  it('points imports of folded areas at Other', () => {
    const files = Array.from({ length: 15 }, (_, i) => `dir${String(i).padStart(2, '0')}/f.ts`);
    const { snapshot } = run([started(0), edit(1, 'dir00/f.ts')], inventoryOf(files), scanOf({ 'dir14/f.ts': ['../dir00/f'], 'dir00/f.ts': [] }));
    expect(snapshot.graph.edges.map((e) => e.id)).toEqual(['merged-other->dir00']);
  });

  it('never lets the inventory create an edge, and keeps "relationships unknown" without a scan', () => {
    const { snapshot, insights } = run(SESSION, INVENTORY, null);
    expect(snapshot.graph.edges).toEqual([]);
    expect(insights.relationships).toBe('unknown');
  });

  it('adds no area for technologies that live only in a manifest', () => {
    const inventory = inventoryOf(['docker-compose.yml', 'src/api/a.ts'], [{ path: 'docker-compose.yml', kind: 'compose', facts: { images: ['postgres', 'redis'] } }]);
    const { snapshot, insights } = run([started(0), edit(1, 'src/api/a.ts')], inventory);
    expect(ids(snapshot.graph)).toEqual(['api', 'config']);
    expect(insights.technologies).toEqual(['Database · PostgreSQL (compose)', 'Cache · Redis (compose)']);
  });
});
