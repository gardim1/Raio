import { describe, expect, it } from 'vitest';
import { classifyPath, groupPaths, HEURISTIC_NOTE, MAX_GROUPS, OTHER_GROUP } from './classifyPath';

describe('classifyPath', () => {
  it('uses the package for monorepo roots', () => {
    expect(classifyPath('apps/web/src/main.tsx')).toEqual({ groupId: 'apps/web', label: 'web', kind: 'frontend' });
    expect(classifyPath('packages/auth/index.ts')).toEqual({ groupId: 'packages/auth', label: 'auth', kind: 'auth' });
    expect(classifyPath('services/billing/handler.ts')).toMatchObject({ groupId: 'services/billing', kind: 'payments' });
    expect(classifyPath('packages/ui-kit/button.tsx')).toMatchObject({ groupId: 'packages/ui-kit', kind: 'other' });
  });

  it('keeps a monorepo package together with its own manifests and tests', () => {
    expect(classifyPath('apps/web/package.json').groupId).toBe('apps/web');
    expect(classifyPath('apps/web/test/app.test.ts').groupId).toBe('apps/web');
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
