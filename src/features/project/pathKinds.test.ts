import { describe, expect, it } from 'vitest';
import { isConfigFile, isDependencyManifest, isMigrationPath, noticeKindForPath } from './pathKinds';

describe('isMigrationPath', () => {
  it('recognises files in migrations directories', () => {
    expect(isMigrationPath('db/migrations/0001_init.sql')).toBe(true);
    expect(isMigrationPath('prisma/migrations/20260101_x/migration.sql')).toBe(true);
    expect(isMigrationPath('src/migrations/add-users.ts')).toBe(true);
  });

  it('recognises .sql files under a db directory', () => {
    expect(isMigrationPath('db/schema.sql')).toBe(true);
    expect(isMigrationPath('src/database/seed.sql')).toBe(true);
  });

  it('does not flag unrelated sql or db files', () => {
    expect(isMigrationPath('scripts/report.sql')).toBe(false);
    expect(isMigrationPath('db/client.ts')).toBe(false);
  });
});

describe('isDependencyManifest', () => {
  it.each(['package.json', 'apps/web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'go.mod', 'go.sum'])(
    'flags %s',
    (path) => expect(isDependencyManifest(path)).toBe(true),
  );

  it.each(['src/package.ts', 'requirements.md', 'notes/go.modern.txt'])('does not flag %s', (path) => expect(isDependencyManifest(path)).toBe(false));
});

describe('isConfigFile', () => {
  it.each(['.env', '.env.production', 'apps/api/.env.local', 'vite.config.ts', 'tailwind.config.js', 'tsconfig.json', 'settings.json', '.claude/settings.local.json', '.eslintrc.json'])('flags %s', (path) =>
    expect(isConfigFile(path)).toBe(true),
  );

  it.each(['src/config/index.ts', 'src/environment.ts', 'README.md'])('does not flag %s', (path) => expect(isConfigFile(path)).toBe(false));
});

describe('noticeKindForPath', () => {
  it('returns one notice kind per path, migration before dependency before config', () => {
    expect(noticeKindForPath('db/migrations/0001.sql')).toBe('migration');
    expect(noticeKindForPath('package.json')).toBe('dependency');
    expect(noticeKindForPath('.env')).toBe('config');
    expect(noticeKindForPath('src/auth/login.ts')).toBeNull();
    expect(noticeKindForPath('outside-project')).toBeNull();
  });
});
