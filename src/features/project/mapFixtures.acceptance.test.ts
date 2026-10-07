import { describe, expect, it } from 'vitest';
import type { RaioEvent } from '../ingest/raioEvent';
import { MAP_FIXTURES } from './mapFixtures.testdata';
import { isProjectInventory } from './projectInventory';
import { projectSessionDetailed } from './projectSession';
import { groupInventory, inventoryNotes } from './inventoryGroups';
import { layoutGroups } from './layoutGroups';

/**
 * Acceptance for the whole-project map against the five throwaway fixture projects (each with an EXPECTED.md that says
 * which areas, hints and edges a good map shows and which claims it must not make). The data is the fixtures' file list,
 * the manifest facts the core returns per Amendment 1 of the contract, and the import specifiers of their TS/JS files.
 */
const PROJECT = { id: 'fx', name: 'fixture' };
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

const event = (seq: number, kind: RaioEvent['kind'], paths: string[] = []): RaioEvent => ({
  schema: 1,
  id: `fx${seq}`,
  source: 'claude-hook',
  provenance: 'agent-reported',
  attribution: 'session',
  projectId: PROJECT.id,
  sessionId: 's1',
  agent: 'claude',
  sourceAt: T0 + seq * 1000,
  observedAt: T0 + seq * 1000,
  seq,
  kind,
  paths,
  evidence: kind === 'file.inspected' ? { toolName: 'Read' } : {},
});

const project = (name: string, touched: string) => {
  const fixture = MAP_FIXTURES[name]!;
  const inventory = { files: fixture.files, truncated: false, skipped: 0, scannedAtMs: 1, manifests: fixture.manifests };
  const imports = { files: fixture.scripts, truncated: false, skipped: 0, scannedAtMs: 1 };
  const projected = projectSessionDetailed(PROJECT, [event(1, 'session.started'), event(2, 'file.inspected', [touched])], undefined, imports, false, inventory);
  if (!projected) throw new Error('expected a projection');
  const { graph } = projected.snapshot;
  return {
    ...projected,
    areas: Object.fromEntries(graph.nodes.map((n) => [n.id, { label: n.label, kind: n.kind, hint: n.hint }])),
    ids: graph.nodes.map((n) => n.id).sort(),
    pairs: [...new Set(graph.edges.map((e) => [e.from, e.to].sort().join('|')))].sort(),
    everything: JSON.stringify({ nodes: graph.nodes.map((n) => [n.id, n.label, n.hint]), edges: graph.edges.map((e) => e.id), insights: projected.insights }),
  };
};

describe('map fixture: django-shop', () => {
  const map = project('django-shop', 'shop/models.py');

  it('shows the Django apps, their migrations, config, templates and static assets', () => {
    expect(map.ids).toEqual(['accounts', 'config', 'shop', 'shop/migrations', 'static', 'templates']);
    expect(map.areas['shop']).toMatchObject({ kind: 'api', hint: 'API · Django' });
    expect(map.areas['accounts']).toMatchObject({ kind: 'api', hint: 'API · Django' });
    expect(map.areas['shop/migrations']).toMatchObject({ kind: 'database', hint: undefined });
    expect(map.areas['config']).toMatchObject({ kind: 'config' });
    expect(map.areas['templates']).toMatchObject({ kind: 'frontend' });
    expect(map.areas['static']).toMatchObject({ kind: 'frontend', hint: undefined });
  });

  it('draws no edge: there is no TS/JS source, and Python imports are out of the contract', () => {
    expect(map.pairs).toEqual([]);
    expect(map.insights.relationships).toBe('unknown');
    expect(map.insights.note).toContain('Relationships between areas are unknown');
  });

  it('claims no engine, no version and nothing from the environment file', () => {
    expect(map.everything).not.toMatch(/PostgreSQL|>=|5\.0|3\.1/);
    expect(map.insights.technologies).toEqual(['API · Django', 'Database · psycopg']);
  });
});

describe('map fixture: express-react', () => {
  const map = project('express-react', 'server/routes/orders.js');

  it('shows server, client, jobs, migrations and tests as folder areas', () => {
    expect(map.ids).toEqual(['client', 'config', 'jobs', 'migrations', 'server', 'tests']);
    expect(map.areas['server']).toMatchObject({ kind: 'api', hint: 'API · Express; Authentication (detected from file names)' });
    expect(map.areas['client']).toMatchObject({ kind: 'frontend', hint: 'Frontend · React' });
    expect(map.areas['jobs']).toMatchObject({ kind: 'jobs', hint: 'Queue · BullMQ' });
    expect(map.areas['migrations']).toMatchObject({ kind: 'database', hint: undefined });
    expect(map.areas['tests']).toMatchObject({ kind: 'other', hint: undefined });
  });

  it('draws exactly the resolvable static imports between areas, and nothing for the fetch from the client', () => {
    expect(map.pairs).toEqual(['jobs|server', 'migrations|server', 'server|tests']);
    expect(map.pairs.some((pair) => pair.includes('client'))).toBe(false);
  });

  it('says server and jobs import each other, instead of showing a hierarchy', () => {
    expect(map.insights.relationships).toMatchObject({ kind: 'static-imports', edges: 3, mutual: 1 });
    expect(map.insights.note).toContain('1 pair of areas import each other');
  });

  it('names the cache client by its package, claims neither PostgreSQL nor a Redis service', () => {
    expect(map.insights.technologies).toEqual(['Frontend · React', 'API · Express', 'Database · pg', 'Queue · BullMQ', 'Cache · ioredis']);
    expect(map.everything).not.toMatch(/PostgreSQL|\(compose\)/);
  });
});

describe('map fixture: fastapi-sqlalchemy', () => {
  const map = project('fastapi-sqlalchemy', 'app/routers/users.py');

  it('shows routers, models, the app core, alembic and tests from folder names alone', () => {
    expect(map.ids).toEqual(['alembic', 'app', 'config', 'models', 'routers', 'tests']);
    expect(map.areas['routers']).toMatchObject({ kind: 'api', hint: 'API · FastAPI' });
    expect(map.areas['app']).toMatchObject({ kind: 'api', hint: 'API · FastAPI' });
    expect(map.areas['models']).toMatchObject({ kind: 'database', hint: 'Database · Alembic, SQLAlchemy' });
    expect(map.areas['alembic']).toMatchObject({ kind: 'database', hint: 'Database · Alembic, SQLAlchemy' });
    expect(map.areas['tests']).toMatchObject({ kind: 'other' });
  });

  it('draws no edge and does not call psycopg a PostgreSQL datasource', () => {
    expect(map.pairs).toEqual([]);
    expect(map.insights.relationships).toBe('unknown');
    expect(map.everything).not.toContain('PostgreSQL');
  });
});

describe('map fixture: go-service', () => {
  const map = project('go-service', 'internal/handlers/orders.go');

  it('shows one Cmd area for the entry points, handlers, store, config and migrations', () => {
    expect(map.ids).toEqual(['cmd', 'config', 'handlers', 'migrations', 'store']);
    expect(map.areas['cmd']).toMatchObject({ label: 'Cmd', kind: 'other' });
    expect(map.areas['handlers']).toMatchObject({ kind: 'api', hint: 'API · chi' });
    expect(map.areas['store']).toMatchObject({ kind: 'database', hint: 'Database · github.com/jackc/pgx/v5' });
    expect(map.areas['migrations']).toMatchObject({ kind: 'database', hint: undefined });
    expect(map.areas['config']).toMatchObject({ kind: 'config' });
  });

  it('draws no edge, shows no version, and names PostgreSQL only as a compose service', () => {
    expect(map.pairs).toEqual([]);
    expect(map.insights.relationships).toBe('unknown');
    expect(map.everything).not.toMatch(/v\d+\.\d+|5\.5\.5|5\.0\.12|alpine/);
    expect(Object.values(map.areas).map((a) => a.hint ?? '').join(' ')).not.toContain('PostgreSQL');
    expect(map.insights.technologies).toContain('Database · github.com/jackc/pgx/v5; PostgreSQL (compose)');
  });
});

describe('map fixture: next-prisma-monorepo', () => {
  const map = project('next-prisma-monorepo', 'apps/web/app/api/orders/route.ts');

  it('splits the web package by its own layout, with the package name as label prefix', () => {
    expect(map.ids).toEqual(['apps/web/api', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'config', 'packages/db/prisma', 'packages/db/src', 'packages/ui/src']);
    expect(map.areas['apps/web/api']).toEqual({ label: 'web/API', kind: 'api', hint: 'API · Next.js' });
    expect(map.areas['apps/web/app']).toEqual({ label: 'web/App', kind: 'frontend', hint: 'Frontend · Next.js' });
    expect(map.areas['apps/web/components']).toEqual({ label: 'web/Components', kind: 'frontend', hint: 'Frontend · Next.js' });
    expect(map.areas['apps/web/lib']).toEqual({ label: 'web/Lib', kind: 'other', hint: 'Authentication (detected from file names)' });
  });

  it('shows the Prisma package with its datasource engine, and the UI package with React', () => {
    expect(map.areas['packages/db/prisma']).toMatchObject({ kind: 'database', hint: 'Database · Prisma (PostgreSQL)' });
    expect(map.areas['packages/db/src']).toMatchObject({ kind: 'database' });
    expect(map.areas['packages/ui/src']).toMatchObject({ kind: 'frontend', hint: 'Frontend · React' });
  });

  it('draws the area-level edges of the relative imports, and none from workspace package names', () => {
    expect(map.pairs).toEqual(['apps/web/api|apps/web/lib', 'apps/web/app|apps/web/components', 'apps/web/app|apps/web/lib', 'apps/web/components|apps/web/lib']);
    expect(map.pairs.some((pair) => pair.includes('packages/'))).toBe(false);
    // Eleven bare package specifiers plus globals.css; the JSDoc type in next.config.mjs is not an import.
    expect(map.insights.relationships).toMatchObject({ unresolved: 12 });
  });

  it('lists Redis only as the compose service it is, once, and the engine of the datasource', () => {
    expect(map.insights.technologies).toEqual(['Frontend · Next.js', 'Database · Prisma (PostgreSQL)', 'Cache · Redis (compose)']);
  });
});

describe('map fixtures: the output of the core', () => {
  it.each(Object.keys(MAP_FIXTURES))('is accepted by the guard: %s', (name) => {
    const fixture = MAP_FIXTURES[name]!;
    expect(isProjectInventory({ files: fixture.files, truncated: false, skipped: 0, scannedAtMs: 1, manifests: fixture.manifests })).toBe(true);
  });
});

describe('map fixture: python-fastapi-next (synthetic)', () => {
  const fixture = MAP_FIXTURES['python-fastapi-next']!;
  const inventory = { files: fixture.files, truncated: false, skipped: 0, scannedAtMs: 1, manifests: fixture.manifests };
  const map = project('python-fastapi-next', 'app/api/routes/records.py');

  it('keeps API, backend logic, integrations, persistence, both interfaces and tests visible despite screenshot-heavy docs', () => {
    expect(fixture.files.length).toBeGreaterThanOrEqual(60);
    expect(fixture.files.length).toBeLessThanOrEqual(90);
    for (const id of ['api', 'services', 'domain', 'integrations', 'repositories', 'alembic', 'frontend', 'templates', 'tests']) {
      expect(map.ids, `missing ${id}`).toContain(id);
    }
    expect(map.areas['api']).toMatchObject({ kind: 'api', hint: 'API · FastAPI' });
    expect(map.areas['repositories']).toMatchObject({ kind: 'database', hint: 'Database · Alembic, SQLAlchemy' });
    expect(map.areas['templates']).toMatchObject({ kind: 'frontend' });
    expect(map.areas['tests']).toMatchObject({ kind: 'other' });
  });

  it('lists frameworks and literal client packages but claims no database engine or dependency-based authentication', () => {
    const names = map.insights.technologies!.join(' ');
    for (const name of ['FastAPI', 'SQLAlchemy', 'Alembic', 'Next.js', 'psycopg', 'google-auth', 'openai']) expect(names).toContain(name);
    expect(names).not.toMatch(/PostgreSQL|MySQL|SQLite|Authentication|Login/i);
    expect(map.areas['integrations']!.hint).toBe('Integrations · google-auth, openai');
    const withoutAuthPaths = { ...inventory, files: ['app/main.py', 'app/integrations/calendar_client.py', 'frontend/app/page.tsx'] };
    expect(JSON.stringify(groupInventory(withoutAuthPaths))).not.toMatch(/Authentication|Login/);
  });

  it('attaches qualified authentication hints only to the areas that contain file or route evidence', () => {
    const hint = 'Authentication (detected from file names)';
    expect(map.areas['admin']!.hint).toBe(`API · FastAPI; ${hint}`);
    expect(map.areas['templates']!.hint).toBe(hint);
    expect(map.areas['frontend']!.hint).toBe(`Frontend · Next.js; ${hint}`);
    for (const id of ['api', 'services', 'domain', 'integrations', 'repositories', 'alembic', 'tests']) {
      expect(map.areas[id]!.hint ?? '', id).not.toContain('Authentication');
    }
  });

  it('draws only the frontend TS import relationship; Python-only inventory still says relationships unknown', () => {
    expect(map.pairs).toEqual(['frontend|tests']);
    const pythonOnly = { ...inventory, files: fixture.files.filter((f) => !f.startsWith('frontend/')), manifests: fixture.manifests.filter((m) => !m.path.startsWith('frontend/')) };
    const projected = projectSessionDetailed(PROJECT, [event(1, 'session.started'), event(2, 'file.inspected', ['app/api/routes/records.py', 'app/services/records.py'])], undefined, { files: [], truncated: false, skipped: 0, scannedAtMs: 1 }, false, pythonOnly)!;
    expect(projected.snapshot.graph.edges).toEqual([]);
    expect(projected.insights.relationships).toBe('unknown');
    expect(projected.insights.note).toContain('Relationships between areas are unknown');
  });

  it('keeps top 12 plus Other and positions stable across file order, activity and extra binary-only folders', () => {
    const initial = groupInventory(inventory);
    const touched = groupInventory(inventory, ['app/utils/formatting.py', 'docs/screenshots/view-1.png']);
    const shuffled = groupInventory({ ...inventory, files: [...fixture.files].reverse() });
    const binaries = groupInventory({ ...inventory, files: [...fixture.files, ...Array.from({ length: 80 }, (_, i) => `illustrations-${i}/preview.png`)] });
    expect(initial.groups).toHaveLength(13);
    expect(initial.groups.at(-1)!.groupId).toBe('merged-other');
    const positions = (groups: typeof initial.groups) => layoutGroups(groups).nodes.map((n) => [n.id, n.position]);
    expect(positions(touched.groups)).toEqual(positions(initial.groups));
    expect(positions(shuffled.groups)).toEqual(positions(initial.groups));
    expect(positions(binaries.groups)).toEqual(positions(initial.groups));
    expect(inventoryNotes({ ...inventory, truncated: true, skipped: 2 })).toEqual([
      'The project listing was partial, so some areas may be missing.',
      '2 files or folders not listed (large, unreadable or online-only).',
    ]);
  });
});
