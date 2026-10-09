import { describe, expect, it } from 'vitest';
import { OUTSIDE_PROJECT } from '../ingest/raioEvent';
import { MAX_GROUPS, OTHER_GROUP } from './classifyPath';
import { groupInventory, inventoryNotes } from './inventoryGroups';
import type { InventoryManifest, ProjectInventory } from './projectInventory';

const inventory = (files: readonly string[], manifests: readonly InventoryManifest[] = [], extra: Partial<ProjectInventory> = {}): ProjectInventory => ({
  files,
  truncated: false,
  skipped: 0,
  scannedAtMs: 0,
  manifests,
  ...extra,
});
const npm = (path: string, facts: Record<string, string[]>): InventoryManifest => ({ path, kind: 'npm', facts });

describe('inventoryNotes: partial listing reasons', () => {
  it('labels only evidence-backed skip categories and omits zeros', () => {
    const notes = inventoryNotes(inventory([], [], { skipped: 37, skippedCloudOnly: 30, skippedUnreadable: 7, skippedTooLarge: 0 }));
    expect(notes).toEqual(['37 items not listed: 30 online-only (cloud placeholders), 7 unreadable.']);
    expect(inventoryNotes(inventory([], [], { skipped: 4 }))[0]).toContain('reason was not recorded');
  });
});

/** id -> [label, kind, hint] of the groups on the map (Other included), independent of ranking order. */
const shape = (inv: ProjectInventory, touched: readonly string[] = []) =>
  Object.fromEntries(groupInventory(inv, touched).groups.map((g) => [g.groupId, [g.label, g.kind, g.hint ?? null]]));

interface Layout {
  readonly name: string;
  readonly inventory: ProjectInventory;
  readonly groups: Record<string, readonly [string, string, string | null]>;
  readonly technologies: readonly string[];
}

const LAYOUTS: readonly Layout[] = [
  {
    name: 'Next.js + Prisma monorepo',
    inventory: inventory(
      [
        'package.json', 'tsconfig.json', 'README.md',
        'apps/web/package.json', 'apps/web/app/page.tsx', 'apps/web/app/layout.tsx', 'apps/web/app/api/users/route.ts', 'apps/web/components/Nav.tsx',
        'apps/admin/package.json', 'apps/admin/app/page.tsx',
        'packages/ui/package.json', 'packages/ui/src/Button.tsx',
        'packages/db/package.json', 'packages/db/src/index.ts', 'packages/db/prisma/schema.prisma', 'packages/db/prisma/migrations/001_init/migration.sql',
      ],
      [
        npm('package.json', { workspaces: ['apps/*', 'packages/*'], devDependencies: ['turbo', 'typescript', 'prisma'], scripts: ['build', 'dev'] }),
        npm('apps/web/package.json', { dependencies: ['next', 'react', 'react-dom'] }),
        npm('apps/admin/package.json', { dependencies: ['next', 'react'] }),
        npm('packages/ui/package.json', { dependencies: ['react'] }),
        npm('packages/db/package.json', { dependencies: ['@prisma/client'] }),
        { path: 'packages/db/prisma/schema.prisma', kind: 'prisma', facts: { provider: ['postgresql'], models: ['User', 'Post'] } },
      ],
    ),
    groups: {
      'apps/web/app': ['web/App', 'frontend', 'Frontend · Next.js'],
      'apps/web/api': ['web/API', 'api', 'API · Next.js'],
      'apps/web/components': ['web/Components', 'frontend', 'Frontend · Next.js'],
      'apps/admin/app': ['admin/App', 'frontend', 'Frontend · Next.js'],
      'packages/ui/src': ['ui/Src', 'frontend', 'Frontend · React'],
      'packages/db/src': ['db/Src', 'database', 'Database · Prisma'],
      'packages/db/prisma': ['db/Prisma', 'database', 'Database · Prisma (PostgreSQL)'],
      config: ['Config', 'config', null],
    },
    technologies: ['Frontend · Next.js', 'Database · Prisma (PostgreSQL)'],
  },
  {
    name: 'single Next.js app with Prisma',
    inventory: inventory(
      [
        'package.json', 'next.config.js', 'README.md',
        'app/page.tsx', 'app/layout.tsx', 'app/dashboard/page.tsx', 'app/api/users/route.ts', 'app/api/auth/route.ts',
        'src/app/api/billing/route.ts',
        'pages/api/hello.ts',
        'components/Header.tsx', 'public/logo.svg',
        'prisma/schema.prisma', 'prisma/migrations/20240101_init/migration.sql',
      ],
      [
        npm('package.json', { dependencies: ['next', 'react', '@prisma/client'], devDependencies: ['prisma'] }),
        { path: 'prisma/schema.prisma', kind: 'prisma', facts: { provider: ['postgresql'], models: ['User'] } },
      ],
    ),
    groups: {
      app: ['App', 'frontend', 'Frontend · Next.js'],
      api: ['API', 'api', 'API · Next.js; Authentication (detected from file names)'],
      components: ['Components', 'frontend', 'Frontend · Next.js'],
      prisma: ['Prisma', 'database', 'Database · Prisma (PostgreSQL)'],
      public: ['Public', 'frontend', null],
      config: ['Config', 'config', null],
    },
    technologies: ['Frontend · Next.js', 'Database · Prisma (PostgreSQL)'],
  },
  {
    name: 'Express API + React SPA',
    inventory: inventory(
      [
        'package.json', 'README.md', 'docker-compose.yml',
        'client/package.json', 'client/index.html', 'client/src/main.tsx', 'client/src/App.tsx',
        'server/package.json', 'server/src/index.ts', 'server/src/routes/users.ts', 'server/src/db/client.ts',
      ],
      [
        npm('package.json', { workspaces: ['client', 'server'] }),
        npm('client/package.json', { dependencies: ['react', 'react-dom'], devDependencies: ['vite'] }),
        npm('server/package.json', { dependencies: ['express', 'pg'] }),
        { path: 'docker-compose.yml', kind: 'compose', facts: { services: ['db', 'cache'], images: ['postgres', 'redis'] } },
      ],
    ),
    groups: {
      client: ['Client', 'frontend', 'Frontend · React'],
      server: ['Server', 'api', 'API · Express'],
      config: ['Config', 'config', null],
    },
    technologies: ['Frontend · React', 'API · Express', 'Database · pg; PostgreSQL (compose)', 'Cache · Redis (compose)'],
  },
  {
    name: 'FastAPI + SQLAlchemy + Alembic',
    inventory: inventory(
      [
        'requirements.txt', 'alembic.ini', 'Dockerfile', 'README.md', 'docker-compose.yml',
        'app/__init__.py', 'app/main.py', 'app/routers/users.py', 'app/routers/items.py', 'app/models/user.py', 'app/models/item.py', 'app/schemas/user.py', 'app/core/config.py',
        'alembic/env.py', 'alembic/versions/0001_init.py',
        'tests/test_users.py',
      ],
      [
        { path: 'requirements.txt', kind: 'python', facts: { packages: ['fastapi', 'uvicorn', 'sqlalchemy', 'alembic', 'psycopg2-binary', 'pydantic'] } },
        { path: 'docker-compose.yml', kind: 'compose', facts: { images: ['postgres'] } },
      ],
    ),
    groups: {
      app: ['App', 'api', 'API · FastAPI'],
      routers: ['Routers', 'api', 'API · FastAPI'],
      models: ['Models', 'database', 'Database · Alembic, SQLAlchemy'],
      alembic: ['Alembic', 'database', 'Database · Alembic, SQLAlchemy'],
      schemas: ['Schemas', 'other', null],
      core: ['Core', 'other', null],
      tests: ['Tests', 'other', null],
      config: ['Config', 'config', null],
    },
    technologies: ['API · FastAPI', 'Database · Alembic, SQLAlchemy, psycopg2-binary; PostgreSQL (compose)'],
  },
  {
    name: 'Django',
    inventory: inventory(
      [
        'manage.py', 'requirements.txt', 'README.md',
        'mysite/__init__.py', 'mysite/settings.py', 'mysite/urls.py', 'mysite/wsgi.py',
        'users/__init__.py', 'users/models.py', 'users/views.py', 'users/urls.py', 'users/migrations/0001_initial.py', 'users/tests.py',
        'blog/models.py', 'blog/views.py', 'blog/templates/blog/post.html',
        'templates/base.html', 'static/css/site.css',
      ],
      [{ path: 'requirements.txt', kind: 'python', facts: { packages: ['django', 'psycopg2-binary', 'gunicorn'] } }],
    ),
    groups: {
      mysite: ['Mysite', 'config', null],
      users: ['Users', 'api', 'API · Django'],
      blog: ['Blog', 'api', 'API · Django'],
      'users/migrations': ['users/migrations', 'database', null],
      templates: ['Templates', 'frontend', null],
      static: ['Static', 'frontend', null],
      config: ['Config', 'config', null],
    },
    technologies: ['API · Django', 'Database · psycopg2-binary'],
  },
  {
    name: 'Go service',
    inventory: inventory(
      [
        'go.mod', 'go.sum', 'Makefile', 'Dockerfile', 'README.md',
        'cmd/server/main.go', 'internal/handlers/users.go', 'internal/handlers/health.go', 'internal/store/users.go', 'internal/models/user.go',
        'pkg/logger/logger.go', 'migrations/001_init.sql', 'migrations/002_users.sql',
      ],
      [{ path: 'go.mod', kind: 'go', facts: { module: ['example.com/svc'], require: ['github.com/gin-gonic/gin', 'gorm.io/gorm', 'github.com/jackc/pgx/v5'] } }],
    ),
    groups: {
      cmd: ['Cmd', 'other', null],
      handlers: ['Handlers', 'api', 'API · Gin'],
      store: ['Store', 'database', 'Database · GORM'],
      models: ['Models', 'database', 'Database · GORM'],
      migrations: ['Migrations', 'database', null],
      logger: ['Logger', 'other', null],
      config: ['Config', 'config', null],
    },
    technologies: ['API · Gin', 'Database · GORM, github.com/jackc/pgx/v5'],
  },
  {
    name: 'docker-compose with PostgreSQL and Redis, workers and infra',
    inventory: inventory(
      [
        'docker-compose.yml', 'package.json',
        'src/server/index.ts', 'src/server/routes/health.ts', 'src/workers/email.ts',
        'infra/terraform/main.tf', 'deploy/k8s/app.yaml',
      ],
      [
        npm('package.json', { dependencies: ['bullmq', 'fastify'] }),
        { path: 'docker-compose.yml', kind: 'compose', facts: { services: ['postgres', 'redis', 'app'], images: ['postgres', 'redis'] } },
      ],
    ),
    groups: {
      server: ['Server', 'api', 'API · Fastify'],
      workers: ['Workers', 'jobs', 'Queue · BullMQ'],
      infra: ['Infra', 'config', null],
      deploy: ['Deploy', 'config', null],
      config: ['Config', 'config', null],
    },
    technologies: ['API · Fastify', 'Database · PostgreSQL (compose)', 'Queue · BullMQ', 'Cache · Redis (compose)'],
  },
];

describe('groupInventory: realistic project layouts', () => {
  it.each(LAYOUTS.map((l) => [l.name, l] as const))('reads %s', (_name, layout) => {
    expect(shape(layout.inventory)).toEqual(layout.groups);
  });

  it.each(LAYOUTS.map((l) => [l.name, l] as const))('lists the technologies named in the manifests of %s', (_name, layout) => {
    expect(groupInventory(layout.inventory).technologies).toEqual(layout.technologies);
  });
});

describe('groupInventory: structure rules', () => {
  it('groups npm workspaces declared outside apps/packages/services', () => {
    const inv = inventory(['libs/core/index.ts', 'libs/core/package.json', 'libs/ui/button.tsx', 'package.json'], [npm('package.json', { workspaces: ['libs/*'] })]);
    expect(Object.keys(shape(inv)).sort()).toEqual(['config', 'libs/core', 'libs/ui']);
  });

  it('groups a workspace declared as an exact nested directory', () => {
    const inv = inventory(['tools/cli/index.ts', 'tools/cli/package.json', 'tools/other/x.ts', 'package.json'], [npm('package.json', { workspaces: ['tools/cli'] })]);
    expect(Object.keys(shape(inv)).sort()).toEqual(['config', 'tools', 'tools/cli']);
  });

  it('puts dot-directories (CI, editor settings) in Config', () => {
    const inv = inventory(['.github/workflows/ci.yml', '.vscode/settings.json', 'src/auth/login.ts']);
    expect(Object.keys(shape(inv)).sort()).toEqual(['auth', 'config']);
  });

  it('does not show the loose files at the project root as an area; touched, they are listed inside Other', () => {
    const inv = inventory(['README.md', 'LICENSE', 'src/auth/login.ts']);
    expect(Object.keys(shape(inv))).toEqual(['auth']);
    expect(Object.keys(shape(inv, ['README.md'])).sort()).toEqual(['auth', 'merged-other']);
    expect(groupInventory(inv, ['README.md']).groups.at(-1)).toMatchObject({ members: ['Project root'] });
  });

  it('never invents an area: an empty or manifest-only project has none', () => {
    expect(groupInventory(inventory([])).groups).toEqual([]);
    expect(groupInventory(inventory([], [npm('package.json', { dependencies: ['express'] })])).groups).toEqual([]);
  });
});

describe('groupInventory: technology hints are manifest names only', () => {
  it('shows no hint when the folders look like an API but no manifest names a framework', () => {
    expect(shape(inventory(['server/index.ts', 'server/routes/a.ts']))['server']).toEqual(['Server', 'api', null]);
  });

  it('does not read values: a version or a URL in a name list matches nothing', () => {
    const inv = inventory(['server/index.ts', 'server/package.json'], [npm('server/package.json', { dependencies: ['^4.18.0', 'https://example.com/express', 'EXPRESS-FAKE'] })]);
    expect(shape(inv)['server']).toEqual(['Server', 'api', null]);
    expect(groupInventory(inv).technologies).toEqual([]);
  });

  it('survives malformed manifests (no facts) and unknown manifest kinds', () => {
    const inv = inventory(['server/index.ts', 'package.json', 'schema.prisma', 'x/build.gradle'], [
      { path: 'package.json', kind: 'npm', facts: {} },
      { path: 'schema.prisma', kind: 'prisma', facts: {} },
      { path: 'x/build.gradle', kind: 'other', facts: { dependencies: ['express'] } },
    ]);
    expect(groupInventory(inv).technologies).toEqual([]);
    expect(shape(inv)['server']).toEqual(['Server', 'api', null]);
  });

  it('names a framework once even when several manifests mention it, and leaves React out when a React meta-framework is present', () => {
    const inv = inventory(['web/a.tsx', 'web/package.json', 'package.json'], [npm('package.json', { dependencies: ['react', 'next'] }), npm('web/package.json', { dependencies: ['next'] })]);
    expect(shape(inv)['web']).toEqual(['Web', 'frontend', 'Frontend · Next.js']);
  });

  it('keeps a manifest inside a package for that package, not for every area of the same kind', () => {
    const inv = inventory(['apps/web/a.tsx', 'apps/web/package.json', 'apps/site/a.tsx', 'apps/site/package.json'], [
      npm('apps/web/package.json', { dependencies: ['next'] }),
      npm('apps/site/package.json', { dependencies: ['vue'] }),
    ]);
    expect(shape(inv)['apps/web']?.[2]).toBe('Frontend · Next.js');
    expect(shape(inv)['apps/site']?.[2]).toBe('Frontend · Vue');
  });

  it('lists a technology that no area on the map can carry (a database named only in compose) without inventing an area for it', () => {
    const inv = inventory(['docker-compose.yml', 'src/web/a.tsx'], [{ path: 'docker-compose.yml', kind: 'compose', facts: { images: ['bitnami/postgresql', 'redis'] } }]);
    expect(Object.keys(shape(inv)).sort()).toEqual(['config', 'web']);
    expect(groupInventory(inv).technologies).toEqual(['Database · PostgreSQL (compose)', 'Cache · Redis (compose)']);
  });
});

describe('groupInventory: the 12 kept areas are the largest, whatever the session touches', () => {
  const dirs = Array.from({ length: 16 }, (_, i) => `dir${String(i).padStart(2, '0')}`);
  // dir00 has 16 files, dir01 has 15, ... dir15 has 1.
  const files = dirs.flatMap((d, i) => Array.from({ length: 16 - i }, (_, n) => `${d}/f${n}.ts`));
  const inv = inventory(files);

  it('keeps the 12 biggest areas and folds the rest into Other', () => {
    const { groups, classify } = groupInventory(inv);
    expect(groups).toHaveLength(MAX_GROUPS + 1);
    expect(groups.slice(0, MAX_GROUPS).map((g) => g.groupId)).toEqual(dirs.slice(0, MAX_GROUPS));
    expect(groups.at(-1)).toEqual(OTHER_GROUP);
    expect(classify('dir15/f0.ts')).toEqual(OTHER_GROUP);
    expect(classify('dir00/f0.ts').groupId).toBe('dir00');
  });

  it('breaks ties between equally large areas by name', () => {
    const tied = inventory(Array.from({ length: 14 }, (_, i) => `d${String(13 - i).padStart(2, '0')}/f.ts`));
    expect(groupInventory(tied).groups.slice(0, MAX_GROUPS).map((g) => g.groupId)).toEqual(Array.from({ length: 12 }, (_, i) => `d${String(i).padStart(2, '0')}`));
  });

  it('never promotes an area a session touched: it is shown inside Other, which lists it', () => {
    const { groups, classify } = groupInventory(inv, ['dir15/f0.ts', 'dir14/f0.ts']);
    expect(groups.slice(0, MAX_GROUPS).map((g) => g.groupId)).toEqual(dirs.slice(0, MAX_GROUPS));
    expect(groups.at(-1)).toMatchObject({ groupId: OTHER_GROUP.groupId, label: 'Other', members: ['Dir14', 'Dir15'] });
    expect(classify('dir15/f0.ts')).toBe(groups.at(-1));
    expect(classify('dir03/f0.ts').groupId).toBe('dir03');
  });

  it('lists only the touched areas in Other, and none when the session touched only kept areas', () => {
    expect(groupInventory(inv, ['dir00/f0.ts']).groups.at(-1)).not.toHaveProperty('members');
    expect(groupInventory(inv, ['dir13/f0.ts']).groups.at(-1)).toMatchObject({ members: ['Dir13'] });
  });

  it('is independent of the order of the files and of the touched paths', () => {
    const a = groupInventory(inv, ['dir14/f0.ts', 'dir15/f0.ts']).groups;
    const b = groupInventory(inventory([...files].reverse()), ['dir15/f0.ts', 'dir14/f0.ts']).groups;
    expect(b).toEqual(a);
  });

  it('routes an area the listing does not hold into Other, with 12 areas or fewer too, and never adds a node of its own', () => {
    const small = inventory(['src/auth/a.ts', 'README.md']);
    const { groups, classify } = groupInventory(small, ['src/web/new.ts', OUTSIDE_PROJECT, 'README.md']);
    expect(groups.map((g) => g.groupId)).toEqual(['auth', OTHER_GROUP.groupId]);
    expect(groups.at(-1)).toMatchObject({ members: ['Outside project', 'Project root', 'Web'] });
    expect(classify('README.md')).toBe(groups.at(-1));
    expect(classify('src/web/new.ts')).toBe(groups.at(-1));
    expect(groupInventory(small).groups.map((g) => g.groupId)).toEqual(['auth']);
    const full = groupInventory(inv, ['newdir/a.ts']);
    expect(full.groups.slice(0, MAX_GROUPS).map((g) => g.groupId)).toEqual(dirs.slice(0, MAX_GROUPS));
    expect(full.groups.at(-1)).toMatchObject({ groupId: OTHER_GROUP.groupId, members: ['Newdir'] });
  });

  it('keeps the same kept areas whatever the session touches', () => {
    const kept = (touched: string[]) => groupInventory(inv, touched).groups.slice(0, MAX_GROUPS);
    expect(kept(['dir00/f0.ts'])).toEqual(kept(['dir05/f1.ts', 'dir01/f2.ts']));
    expect(kept([])).toEqual(kept(['dir15/f0.ts']));
    expect(kept([])).toEqual(kept(['dir14/f0.ts', 'dir13/f2.ts', 'brandnew/x.ts']));
  });

  it('answers the same map object when the touched areas outside the kept ones are the same, so the import edges derived from it are reused', () => {
    expect(groupInventory(inv, ['dir02/f0.ts'])).toBe(groupInventory(inv, ['dir03/f0.ts']));
    expect(groupInventory(inv, [])).toBe(groupInventory(inv));
    expect(groupInventory(inv, ['dir15/f0.ts'])).toBe(groupInventory(inv, ['dir15/f3.ts', 'dir01/f0.ts']));
    expect(groupInventory(inv, ['dir15/f0.ts'])).not.toBe(groupInventory(inv, ['dir14/f0.ts']));
    expect(groupInventory(inv, ['dir15/f0.ts'])).not.toBe(groupInventory(inv));
  });
});

describe('groupInventory: names that only mean something in a backend layout', () => {
  const kinds = (files: string[]) => Object.fromEntries(Object.entries(shape(inventory(files))).map(([id, [, kind]]) => [id, kind]));

  it('does not call a Redux store, a TS models folder or a gulp tasks folder a database or a queue', () => {
    expect(kinds(['src/store/index.ts', 'src/models/user.ts', 'tasks/build.js', 'src/entities/a.ts'])).toEqual({ store: 'other', models: 'other', tasks: 'other', entities: 'other' });
  });

  it('does in a Python, Go or other backend language layout', () => {
    expect(kinds(['app/models/user.py', 'tasks/send.py', 'internal/store/users.go', 'internal/repositories/r.go', 'src/entities/User.java'])).toMatchObject({
      models: 'database',
      tasks: 'jobs',
      store: 'database',
      repositories: 'database',
      entities: 'database',
    });
  });
});

describe('groupInventory: assets and migrations', () => {
  it('recognizes a Python database module without treating frontend database utilities as persistence', () => {
    const map = groupInventory(inventory(['app/core/database.py', 'app/core/config.py', 'frontend/lib/database.ts']));
    expect(map.classify('app/core/database.py').kind).toBe('database');
    expect(map.classify('frontend/lib/database.ts').kind).toBe('frontend');
  });

  it('ranks informative files above binary-only areas without dropping their path mapping', () => {
    const source = Array.from({ length: 12 }, (_, i) => `area${String(i).padStart(2, '0')}/file.ts`);
    const pictures = Array.from({ length: 100 }, (_, i) => `docs/screenshots/view-${i}.png`);
    const map = groupInventory(inventory([...pictures, ...source]));
    expect(map.groups.slice(0, MAX_GROUPS).map((g) => g.groupId)).toEqual(Array.from({ length: 12 }, (_, i) => `area${String(i).padStart(2, '0')}`));
    expect(map.classify(pictures[0]!)!.groupId).toBe('merged-other');
    expect(groupInventory(inventory(['static/logo.svg'])).groups.map((g) => g.groupId)).toEqual(['static']);
  });

  it('uses source/template names for authentication hints, never docs, images, substrings or dependencies alone', () => {
    for (const path of ['app/admin/auth.py', 'frontend/lib/session.ts', 'frontend/app/password-reset/page.tsx', 'app/admin/templates/login.html', 'src/auth/index.ts']) {
      expect(groupInventory(inventory([path])).classify(path).hint, path).toContain('Authentication (detected from file names)');
    }
    const files = ['app/main.py', 'app/integrations/calendar_client.py', 'docs/login.md', 'docs/screenshots/login.png', 'src/utils/author.ts', 'src/utils/google_auth_client.py'];
    const map = groupInventory(inventory(files, [{ path: 'pyproject.toml', kind: 'python', facts: { packages: ['google-auth'] } }]));
    expect(map.groups.map((g) => g.hint ?? '').join(' ')).not.toContain('Authentication');
  });

  it('gives static, public and assets folders no technology hint', () => {
    const inv = inventory(['static/a.css', 'public/b.svg', 'web/app.tsx', 'package.json'], [npm('package.json', { dependencies: ['react'] })]);
    const groups = shape(inv);
    expect(groups['static']).toEqual(['Static', 'frontend', null]);
    expect(groups['public']).toEqual(['Public', 'frontend', null]);
    expect(groups['web']?.[2]).toBe('Frontend · React');
  });

  it('gives a migrations folder no hint from a root manifest', () => {
    const inv = inventory(['migrations/001.sql', 'store/a.go', 'go.mod'], [{ path: 'go.mod', kind: 'go', facts: { require: ['gorm.io/gorm'] } }]);
    expect(shape(inv)['migrations']).toEqual(['Migrations', 'database', null]);
    expect(shape(inv)['store']?.[2]).toBe('Database · GORM');
  });
});
