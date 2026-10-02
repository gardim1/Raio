import { describe, expect, it } from 'vitest';
import type { InventoryManifest } from './projectInventory';
import { describeArea, detectTechnologies } from './technologies';

const m = (kind: InventoryManifest['kind'], facts: Record<string, string[]>, path = 'manifest'): InventoryManifest => ({ path, kind, facts });
const names = (manifests: InventoryManifest[]) => detectTechnologies(manifests).map((t) => `${t.area}:${t.name}:${t.role}:${t.via}`).sort();

describe('detectTechnologies: reads exactly the documented fact keys', () => {
  it('npm: dependencies, devDependencies and peerDependencies; never workspaces, scripts or other keys', () => {
    expect(names([m('npm', { dependencies: ['express'], devDependencies: ['vite', 'react'], peerDependencies: ['vue'] })])).toEqual([
      'API:Express:tool:manifest',
      'Frontend:React:tool:manifest',
      'Frontend:Vue:tool:manifest',
    ]);
    expect(names([m('npm', { scripts: ['next', 'express'], workspaces: ['react'], optionalDependencies: ['express'], members: ['express'] })])).toEqual([]);
  });

  it('python: packages only', () => {
    expect(names([m('python', { packages: ['FastAPI', 'SQLAlchemy', 'Flask_Login'] })])).toEqual(['API:FastAPI:tool:manifest', 'Database:SQLAlchemy:tool:manifest']);
    expect(names([m('python', { dependencies: ['fastapi'], require: ['fastapi'] })])).toEqual([]);
  });

  it('go: required modules only, not the module path of the project itself', () => {
    expect(names([m('go', { module: ['github.com/gin-gonic/gin'], require: ['github.com/go-chi/chi/v5'] })])).toEqual(['API:chi:tool:manifest']);
    expect(names([m('go', { packages: ['github.com/go-chi/chi/v5'] })])).toEqual([]);
  });

  it('rust: dependencies only, not workspace members', () => {
    expect(names([m('rust', { dependencies: ['axum'], members: ['rocket'] })])).toEqual(['API:Axum:tool:manifest']);
  });

  it('compose: images only, not service names', () => {
    expect(names([m('compose', { services: ['postgres', 'redis'], images: ['rabbitmq'] })])).toEqual(['Queue:RabbitMQ:engine:compose']);
  });

  it('prisma: the datasource provider names an engine; a manifest without facts names nothing', () => {
    expect(names([m('prisma', { provider: ['postgresql'], models: ['User'] })])).toEqual(['Database:PostgreSQL:engine:provider', 'Database:Prisma:tool:manifest']);
    expect(names([m('prisma', { models: ['User'] })])).toEqual(['Database:Prisma:tool:manifest']);
    expect(names([m('prisma', {})])).toEqual([]);
    expect(names([m('prisma', { provider: ['prisma-client-js'] })])).toEqual(['Database:Prisma:tool:manifest']);
  });

  it('matches names exactly: a version, a URL or a lookalike never matches', () => {
    expect(names([m('npm', { dependencies: ['^4.18.0', 'https://example.com/express', 'EXPRESS', 'expressive'] })])).toEqual([]);
  });
});

describe('detectTechnologies: engines come only from compose images or the prisma provider', () => {
  it.each([
    ['npm', 'pg'],
    ['npm', 'mysql2'],
    ['npm', 'mongodb'],
    ['npm', 'better-sqlite3'],
    ['python', 'psycopg'],
    ['python', 'psycopg2-binary'],
    ['python', 'asyncpg'],
    ['python', 'pymongo'],
    ['python', 'pymysql'],
    ['go', 'github.com/jackc/pgx/v5'],
    ['go', 'github.com/lib/pq'],
    ['go', 'github.com/go-sql-driver/mysql'],
  ] as const)('%s package %s is a driver listed by its literal name, never an engine', (kind, name) => {
    const key = kind === 'npm' ? 'dependencies' : kind === 'python' ? 'packages' : 'require';
    const found = detectTechnologies([m(kind, { [key]: [name] })]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ area: 'Database', name, role: 'driver', via: 'manifest' });
  });

  it('lists a cache client by its package name and never as the Redis service', () => {
    for (const [kind, key, name] of [['npm', 'dependencies', 'ioredis'], ['npm', 'dependencies', 'redis'], ['python', 'packages', 'redis']] as const) {
      expect(detectTechnologies([m(kind, { [key]: [name] })])[0]).toMatchObject({ area: 'Cache', name, role: 'driver' });
    }
  });

  it('names an engine from compose images, whatever the registry or namespace', () => {
    expect(names([m('compose', { images: ['postgres', 'bitnami/postgresql', 'mariadb', 'mongo', 'redis', 'valkey'] })])).toEqual([
      'Cache:Redis:engine:compose',
      'Database:MongoDB:engine:compose',
      'Database:MySQL:engine:compose',
      'Database:PostgreSQL:engine:compose',
    ]);
  });
});

describe('describeArea', () => {
  const t = (kind: InventoryManifest['kind'], facts: Record<string, string[]>) => detectTechnologies([m(kind, facts)]);

  it('puts the engine of the datasource provider in parentheses after the tool', () => {
    expect(describeArea('Database', t('prisma', { provider: ['postgresql'], models: ['User'] }))).toBe('Database · Prisma (PostgreSQL)');
  });

  it('lists a driver by its literal name when no tool is named, and not at all beside a tool', () => {
    expect(describeArea('Database', t('npm', { dependencies: ['pg'] }))).toBe('Database · pg');
    expect(describeArea('Database', t('go', { require: ['github.com/jackc/pgx/v5'] }))).toBe('Database · github.com/jackc/pgx/v5');
    expect(describeArea('Database', t('python', { packages: ['sqlalchemy', 'psycopg', 'alembic'] }))).toBe('Database · Alembic, SQLAlchemy');
  });

  it('marks an engine named only by compose, apart from the tools, and does not repeat one the provider already names', () => {
    expect(describeArea('Database', t('compose', { images: ['postgres'] }))).toBe('Database · PostgreSQL (compose)');
    const both = [...t('prisma', { provider: ['postgresql'], models: ['User'] }), ...t('compose', { images: ['postgres', 'mysql'] })];
    expect(describeArea('Database', both)).toBe('Database · Prisma (PostgreSQL); MySQL (compose)');
    expect(describeArea('Database', [...t('npm', { dependencies: ['drizzle-orm'] }), ...t('compose', { images: ['postgres'] })])).toBe('Database · Drizzle; PostgreSQL (compose)');
  });

  it('keeps the cache client and the compose service apart', () => {
    expect(describeArea('Cache', t('compose', { images: ['redis'] }))).toBe('Cache · Redis (compose)');
    expect(describeArea('Cache', t('npm', { dependencies: ['ioredis'] }))).toBe('Cache · ioredis');
    expect(describeArea('Cache', [...t('npm', { dependencies: ['ioredis'] }), ...t('compose', { images: ['redis'] })])).toBe('Cache · ioredis; Redis (compose)');
  });

  it('can leave compose out, for the hint of one area (a compose file is about the whole project)', () => {
    const all = [...t('npm', { dependencies: ['drizzle-orm'] }), ...t('compose', { images: ['postgres'] })];
    expect(describeArea('Database', all, { compose: false })).toBe('Database · Drizzle');
    expect(describeArea('Database', t('compose', { images: ['postgres'] }), { compose: false })).toBeNull();
  });

  it('leaves React out beside a React meta-framework, and is null for an area with nothing', () => {
    expect(describeArea('Frontend', t('npm', { dependencies: ['react', 'next'] }))).toBe('Frontend · Next.js');
    expect(describeArea('Frontend', t('npm', { dependencies: ['react'] }))).toBe('Frontend · React');
    expect(describeArea('Queue', t('npm', { dependencies: ['react'] }))).toBeNull();
  });
});
