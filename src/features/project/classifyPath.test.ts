import { describe, expect, it } from 'vitest';
import { classifyPath, groupPaths, HEURISTIC_NOTE, MAX_GROUPS, OTHER_GROUP } from './classifyPath';

describe('classifyPath', () => {
  it('separates Python server templates, frontend tests and client modules by path evidence', () => {
    expect(classifyPath('app/admin/templates/login.html')).toMatchObject({ groupId: 'templates', kind: 'frontend' });
    expect(classifyPath('frontend/tests/records.test.ts')).toMatchObject({ groupId: 'tests', kind: 'other' });
    expect(classifyPath('app/core/calendar_client.py')).toMatchObject({ groupId: 'integrations', label: 'Integrations', kind: 'other' });
    expect(classifyPath('src/adapters/sms_client.ts')).toMatchObject({ groupId: 'integrations', kind: 'other' });
    expect(classifyPath('tests/test_sms_client.py')).toMatchObject({ groupId: 'tests', kind: 'other' });
    expect(classifyPath('docs/sms_client.png')).toMatchObject({ groupId: 'docs' });
  });

  it('uses the package for monorepo roots', () => {
    expect(classifyPath('apps/web/src/main.tsx')).toEqual({ groupId: 'apps/web/src', label: 'web/Src', kind: 'frontend' });
    expect(classifyPath('packages/auth/index.ts')).toEqual({ groupId: 'packages/auth', label: 'auth', kind: 'auth' });
    expect(classifyPath('services/billing/handler.ts')).toMatchObject({ groupId: 'services/billing', kind: 'payments' });
    expect(classifyPath('packages/ui-kit/button.tsx')).toMatchObject({ groupId: 'packages/ui-kit', kind: 'other' });
  });

  it('splits a monorepo package by its own layout, with the package name as label prefix', () => {
    expect(classifyPath('apps/web/app/page.tsx')).toEqual({ groupId: 'apps/web/app', label: 'web/App', kind: 'frontend' });
    expect(classifyPath('apps/web/components/Header.tsx')).toEqual({ groupId: 'apps/web/components', label: 'web/Components', kind: 'frontend' });
    expect(classifyPath('apps/web/lib/db.ts')).toEqual({ groupId: 'apps/web/lib', label: 'web/Lib', kind: 'other' });
    expect(classifyPath('apps/web/test/app.test.ts')).toEqual({ groupId: 'apps/web/tests', label: 'web/Tests', kind: 'other' });
    expect(classifyPath('apps/api/db/client.ts')).toEqual({ groupId: 'apps/api/db', label: 'api/DB', kind: 'database' });
  });

  it('shows Next.js route handlers inside a package as an API area of that package', () => {
    expect(classifyPath('apps/web/app/api/users/route.ts')).toEqual({ groupId: 'apps/web/api', label: 'web/API', kind: 'api' });
    expect(classifyPath('apps/web/src/pages/api/hello.ts')).toEqual({ groupId: 'apps/web/api', label: 'web/API', kind: 'api' });
  });

  it('sends the manifests and config files of a package to Config, and its loose files to the package itself', () => {
    expect(classifyPath('apps/web/package.json').groupId).toBe('config');
    expect(classifyPath('apps/web/next.config.mjs').groupId).toBe('config');
    expect(classifyPath('apps/web/tsconfig.json').groupId).toBe('config');
    expect(classifyPath('apps/web/index.ts')).toEqual({ groupId: 'apps/web', label: 'web', kind: 'frontend' });
    expect(classifyPath('apps/web/README.md').groupId).toBe('apps/web');
  });

  it('does not treat a loose file under a monorepo root as a package', () => {
    expect(classifyPath('packages/README.md')).toMatchObject({ groupId: 'packages', kind: 'other' });
  });

  it('uses the next segment under src/ or lib/', () => {
    expect(classifyPath('src/auth/login.ts')).toEqual({ groupId: 'auth', label: 'Auth', kind: 'auth' });
    expect(classifyPath('lib/payments/charge.ts')).toMatchObject({ groupId: 'payments', kind: 'payments' });
    expect(classifyPath('src/billing/invoice.ts')).toMatchObject({ groupId: 'billing', kind: 'payments' });
    expect(classifyPath('src/unusual/thing.ts')).toEqual({ groupId: 'unusual', label: 'Unusual', kind: 'other' });
  });

  it.each([
    ['src/web/a.ts', 'frontend'],
    ['src/frontend/a.ts', 'frontend'],
    ['src/client/a.ts', 'frontend'],
    ['src/app/a.ts', 'frontend'],
    ['src/components/a.tsx', 'frontend'],
    ['src/pages/a.tsx', 'frontend'],
    ['src/api/a.ts', 'api'],
    ['src/server/a.ts', 'api'],
    ['src/routes/a.ts', 'api'],
    ['src/handlers/a.ts', 'api'],
    ['src/db/a.ts', 'database'],
    ['src/database/a.ts', 'database'],
    ['prisma/schema.prisma', 'database'],
    ['db/migrations/0001.sql', 'database'],
    ['src/models/user.ts', 'database'],
    ['src/schema/user.ts', 'database'],
    ['src/storage/a.ts', 'storage'],
    ['src/uploads/a.ts', 'storage'],
    ['src/s3/a.ts', 'storage'],
    ['src/config/a.ts', 'config'],
    ['src/jobs/a.ts', 'jobs'],
    ['src/workers/a.ts', 'jobs'],
    ['src/queues/a.ts', 'jobs'],
  ])('maps %s to kind %s', (path, kind) => {
    expect(classifyPath(path).kind).toBe(kind);
  });

  it('labels conventional acronyms readably', () => {
    expect(classifyPath('src/api/a.ts').label).toBe('API');
    expect(classifyPath('src/db/a.ts').label).toBe('DB');
    expect(classifyPath('src/s3/a.ts').label).toBe('S3');
  });

  it('collects test folders into one Tests group of kind other', () => {
    for (const path of ['test/login.test.mjs', 'tests/a.ts', 'src/__tests__/a.ts', 'spec/a.ts', 'src/spec/a.ts']) {
      expect(classifyPath(path), path).toEqual({ groupId: 'tests', label: 'Tests', kind: 'other' });
    }
  });

  it('puts config and manifest files at the project root into Config', () => {
    for (const path of ['package.json', 'package-lock.json', 'Cargo.toml', 'pyproject.toml', 'requirements-dev.txt', 'go.mod', '.env', '.env.local', 'vite.config.ts', 'tsconfig.json', 'settings.json']) {
      expect(classifyPath(path), path).toEqual({ groupId: 'config', label: 'Config', kind: 'config' });
    }
  });

  it('puts other root files into Project root', () => {
    expect(classifyPath('README.md')).toEqual({ groupId: 'project-root', label: 'Project root', kind: 'other' });
    expect(classifyPath('LICENSE')).toMatchObject({ groupId: 'project-root' });
  });

  it('falls back to the top-level directory', () => {
    expect(classifyPath('docs/guide/intro.md')).toEqual({ groupId: 'docs', label: 'Docs', kind: 'other' });
    expect(classifyPath('.github/workflows/ci.yml')).toMatchObject({ groupId: '.github', kind: 'other' });
    expect(classifyPath('src/main.ts')).toMatchObject({ groupId: 'src' });
  });

  it('is case-insensitive for directory names and tolerates ./ and backslashes', () => {
    expect(classifyPath('SRC/Auth/Login.ts').groupId).toBe('auth');
    expect(classifyPath('./src/auth/login.ts').groupId).toBe('auth');
    expect(classifyPath('src\\auth\\login.ts').groupId).toBe('auth');
  });

  it('gives paths outside the project their own group', () => {
    expect(classifyPath('outside-project')).toEqual({ groupId: 'outside-project', label: 'Outside project', kind: 'other' });
  });

  it('states that grouping is a heuristic', () => {
    expect(HEURISTIC_NOTE).toMatch(/heuristic/i);
  });
});

describe('groupPaths', () => {
  it('returns each group once with a path-to-group lookup', () => {
    const { groups, groupOf } = groupPaths(['src/auth/a.ts', 'src/auth/b.ts', 'src/api/c.ts']);
    expect(groups.map((g) => g.groupId).sort()).toEqual(['api', 'auth']);
    expect(groupOf.get('src/auth/b.ts')?.groupId).toBe('auth');
  });

  it('caps the result at 12 groups and merges the rest into Other', () => {
    const paths = Array.from({ length: 16 }, (_, i) => `dir${String(i).padStart(2, '0')}/file.ts`);
    const { groups, groupOf } = groupPaths(paths);
    expect(groups).toHaveLength(MAX_GROUPS + 1);
    expect(groups.at(-1)).toEqual(OTHER_GROUP);
    expect(groupOf.get('dir15/file.ts')).toEqual(OTHER_GROUP);
    expect([...groupOf.values()].filter((g) => g.groupId !== OTHER_GROUP.groupId)).toHaveLength(MAX_GROUPS);
  });

  it('keeps the groups with the most paths and breaks ties by label', () => {
    const busy = ['zeta/a.ts', 'zeta/b.ts', 'zeta/c.ts'];
    const rest = Array.from({ length: 12 }, (_, i) => `d${String(i).padStart(2, '0')}/f.ts`);
    const { groupOf } = groupPaths([...rest, ...busy]);
    expect(groupOf.get('zeta/a.ts')?.groupId).toBe('zeta');
    // 13 groups, so exactly one is merged: the alphabetically last of the equally small ones.
    expect(groupOf.get('d11/f.ts')).toEqual(OTHER_GROUP);
    expect(groupOf.get('d00/f.ts')?.groupId).toBe('d00');
  });

  it('is independent of input order', () => {
    const paths = Array.from({ length: 16 }, (_, i) => `dir${i}/f.ts`);
    const a = groupPaths(paths).groups.map((g) => g.groupId);
    const b = groupPaths([...paths].reverse()).groups.map((g) => g.groupId);
    expect(b).toEqual(a);
  });

  it('does not add Other when nothing needs merging', () => {
    expect(groupPaths(['a/x.ts', 'b/y.ts']).groups.some((g) => g.groupId === OTHER_GROUP.groupId)).toBe(false);
  });
});

describe('classifyPath: common project layouts', () => {
  it.each([
    ['app/api/users/route.ts', 'api'],
    ['src/app/api/users/route.ts', 'api'],
    ['pages/api/hello.ts', 'api'],
    ['src/pages/api/hello.ts', 'api'],
  ])('sends the Next.js route handler %s to the API group', (path, kind) => {
    expect(classifyPath(path)).toEqual({ groupId: 'api', label: 'API', kind });
  });

  it('keeps the other Next.js app and pages files with the frontend', () => {
    expect(classifyPath('app/dashboard/page.tsx')).toMatchObject({ groupId: 'app', kind: 'frontend' });
    expect(classifyPath('pages/index.tsx')).toMatchObject({ groupId: 'pages', kind: 'frontend' });
    expect(classifyPath('src/app/page.tsx')).toMatchObject({ groupId: 'app', kind: 'frontend' });
  });

  it('does not treat a file called api.ts as the API folder', () => {
    expect(classifyPath('app/api.ts')).toMatchObject({ groupId: 'app' });
  });

  it.each([
    ['backend/main.py', 'backend', 'api'],
    ['server/index.ts', 'server', 'api'],
    ['frontend/src/App.tsx', 'frontend', 'frontend'],
    ['templates/base.html', 'templates', 'frontend'],
    ['routers/users.py', 'routers', 'api'],
    ['controllers/users.ts', 'controllers', 'api'],
    ['alembic/env.py', 'alembic', 'database'],
    ['supabase/config.toml', 'supabase', 'database'],
    ['supabase/migrations/001.sql', 'supabase', 'database'],
    ['migrations/001_init.sql', 'migrations', 'database'],
    ['infra/main.tf', 'infra', 'config'],
    ['deploy/k8s/app.yaml', 'deploy', 'config'],
    ['terraform/main.tf', 'terraform', 'config'],
    ['worker/main.py', 'worker', 'jobs'],
    ['static/css/site.css', 'static', 'frontend'],
    ['public/logo.svg', 'public', 'frontend'],
    ['assets/logo.svg', 'assets', 'frontend'],
  ])('maps %s to group %s of kind %s', (path, groupId, kind) => {
    expect(classifyPath(path)).toMatchObject({ groupId, kind });
  });

  it('uses the next segment under app/ for Python packages, but not for TS/JS app folders', () => {
    expect(classifyPath('app/routers/users.py')).toMatchObject({ groupId: 'routers', kind: 'api' });
    expect(classifyPath('app/models/user.py')).toMatchObject({ groupId: 'models', kind: 'database' });
    expect(classifyPath('app/main.py')).toMatchObject({ groupId: 'app' });
    expect(classifyPath('app/routers/users.ts')).toMatchObject({ groupId: 'app' });
  });

  it('uses the next segment under internal/ and pkg/ for Go services', () => {
    expect(classifyPath('internal/handlers/users.go')).toMatchObject({ groupId: 'handlers', kind: 'api' });
    expect(classifyPath('pkg/logger/logger.go')).toMatchObject({ groupId: 'logger', kind: 'other' });
  });

  it('keeps every Go entry point in one Cmd area, whatever the binary is called', () => {
    for (const path of ['cmd/api/main.go', 'cmd/server/main.go', 'cmd/migrate/main.go', 'cmd/worker/main.go']) {
      expect(classifyPath(path), path).toEqual({ groupId: 'cmd', label: 'Cmd', kind: 'other' });
    }
  });

  it('keeps names that only mean something in a backend layout out of the plain classifier', () => {
    for (const path of ['src/store/index.ts', 'src/entities/user.ts', 'tasks/build.js', 'store/user.go']) {
      expect(classifyPath(path).kind, path).toBe('other');
    }
  });

  it('makes a migrations folder inside an app its own Database area, but leaves database folders alone', () => {
    expect(classifyPath('shop/migrations/0001_initial.py')).toEqual({ groupId: 'shop/migrations', label: 'shop/migrations', kind: 'database' });
    expect(classifyPath('shop/models.py').groupId).toBe('shop');
    expect(classifyPath('prisma/migrations/0001/migration.sql').groupId).toBe('prisma');
    expect(classifyPath('db/migrations/0001.sql').groupId).toBe('db');
    expect(classifyPath('supabase/migrations/001.sql').groupId).toBe('supabase');
  });

  it('puts Docker and compose files at the project root into Config', () => {
    for (const path of ['Dockerfile', 'docker-compose.yml', 'docker-compose.override.yaml', 'compose.yml']) {
      expect(classifyPath(path), path).toMatchObject({ groupId: 'config' });
    }
  });

  it('keeps one kind per group id, whatever the file inside, so grouping stays order-independent', () => {
    const a = groupPaths(['app/main.py', 'app/README.md']).groups;
    const b = groupPaths(['app/README.md', 'app/main.py']).groups;
    expect(b).toEqual(a);
  });

  it('uses workspace package roots when given', () => {
    const context = { packageRoots: ['libs'], packageDirs: ['tools/cli'] };
    expect(classifyPath('libs/core/index.ts', context)).toEqual({ groupId: 'libs/core', label: 'core', kind: 'other' });
    expect(classifyPath('libs/core/src/a.ts', context)).toEqual({ groupId: 'libs/core/src', label: 'core/Src', kind: 'other' });
    expect(classifyPath('libs/README.md', context)).toMatchObject({ groupId: 'libs' });
    expect(classifyPath('tools/cli/src/a.ts', context)).toEqual({ groupId: 'tools/cli/src', label: 'cli/Src', kind: 'other' });
    expect(classifyPath('tools/cli/main.ts', context)).toEqual({ groupId: 'tools/cli', label: 'cli', kind: 'other' });
    expect(classifyPath('tools/other/a.ts', context)).toMatchObject({ groupId: 'tools' });
    expect(classifyPath('libs/core/index.ts')).toMatchObject({ groupId: 'libs' });
  });
});
