import type { SystemKind } from '../architecture/model/types';
import type { InventoryManifest } from './projectInventory';

/**
 * Technologies a project's manifests NAME (a dependency, a compose image, a datasource provider). Matching is by exact
 * package or image name against the tables below; a version, a URL or any value never matches, and nothing is guessed
 * from code. Everything here is a heuristic hint ("the manifest names Express"), not proof that the area uses it.
 *
 * Only the documented fact keys are read (see `InventoryManifest`). A database or cache ENGINE (PostgreSQL, Redis, ...)
 * is named only by a compose `images` entry or by the prisma datasource `provider`: a driver or client package (pg,
 * psycopg, pgx, ioredis, ...) never implies one, and is listed by its literal package name at most.
 */
export type TechArea = 'Frontend' | 'API' | 'Database' | 'Queue' | 'Cache';

export const TECH_AREAS: readonly TechArea[] = ['Frontend', 'API', 'Database', 'Queue', 'Cache'];

/** The kind of map area a technology area describes. `Cache` has no area of its own, so it is only listed in the copy. */
export const KIND_OF_AREA: Readonly<Record<TechArea, SystemKind | null>> = { Frontend: 'frontend', API: 'api', Database: 'database', Queue: 'jobs', Cache: null };
export const AREA_OF_KIND: Readonly<Partial<Record<SystemKind, TechArea>>> = { frontend: 'Frontend', api: 'API', database: 'Database', jobs: 'Queue' };

export const NEXT_JS = 'Next.js';

export interface Technology {
  readonly area: TechArea;
  readonly name: string;
  /**
   * `tool`: a framework, ORM or library by its display name. `driver`: a client package, listed by its literal name.
   * `engine`: a service or datastore (PostgreSQL), named by a compose image or the prisma datasource provider.
   */
  readonly role: 'tool' | 'driver' | 'engine';
  /** `provider`: the prisma datasource, which says which engine that schema targets. `compose`: a service the project declares. */
  readonly via: 'manifest' | 'provider' | 'compose';
  /** The manifest that names it; its folder decides which areas it belongs to. */
  readonly manifestPath: string;
}

interface Entry {
  readonly area: TechArea;
  /** Display name; absent for a driver, which is listed by the literal name found in the manifest. */
  readonly name?: string;
  readonly role: Technology['role'];
  /** Not listed when one of these is (React is implied by Next.js). */
  readonly impliedBy?: readonly string[];
}

const tool = (area: TechArea, name: string, impliedBy?: readonly string[]): Entry => ({ area, name, role: 'tool', ...(impliedBy ? { impliedBy } : {}) });
const driver = (area: 'Database' | 'Cache'): Entry => ({ area, role: 'driver' });
const engine = (area: 'Database' | 'Cache' | 'Queue', name: string): Entry => ({ area, name, role: 'engine' });

const NPM: Readonly<Record<string, Entry>> = {
  next: tool('Frontend', NEXT_JS),
  nuxt: tool('Frontend', 'Nuxt'),
  '@sveltejs/kit': tool('Frontend', 'SvelteKit'),
  '@remix-run/react': tool('Frontend', 'Remix'),
  astro: tool('Frontend', 'Astro'),
  gatsby: tool('Frontend', 'Gatsby'),
  react: tool('Frontend', 'React', [NEXT_JS, 'Remix', 'Gatsby']),
  vue: tool('Frontend', 'Vue', ['Nuxt']),
  svelte: tool('Frontend', 'Svelte', ['SvelteKit']),
  '@angular/core': tool('Frontend', 'Angular'),
  'solid-js': tool('Frontend', 'Solid'),
  '@nestjs/core': tool('API', 'NestJS'),
  fastify: tool('API', 'Fastify'),
  express: tool('API', 'Express'),
  koa: tool('API', 'Koa'),
  hono: tool('API', 'Hono'),
  '@hapi/hapi': tool('API', 'hapi'),
  prisma: tool('Database', 'Prisma'),
  '@prisma/client': tool('Database', 'Prisma'),
  'drizzle-orm': tool('Database', 'Drizzle'),
  typeorm: tool('Database', 'TypeORM'),
  sequelize: tool('Database', 'Sequelize'),
  mongoose: tool('Database', 'Mongoose'),
  knex: tool('Database', 'Knex'),
  pg: driver('Database'),
  mysql2: driver('Database'),
  mongodb: driver('Database'),
  'better-sqlite3': driver('Database'),
  sqlite3: driver('Database'),
  bullmq: tool('Queue', 'BullMQ'),
  bull: tool('Queue', 'Bull'),
  'bee-queue': tool('Queue', 'Bee-Queue'),
  agenda: tool('Queue', 'Agenda'),
  redis: driver('Cache'),
  ioredis: driver('Cache'),
};

const PYTHON: Readonly<Record<string, Entry>> = {
  fastapi: tool('API', 'FastAPI'),
  django: tool('API', 'Django'),
  flask: tool('API', 'Flask'),
  sqlalchemy: tool('Database', 'SQLAlchemy'),
  alembic: tool('Database', 'Alembic'),
  psycopg2: driver('Database'),
  'psycopg2-binary': driver('Database'),
  psycopg: driver('Database'),
  asyncpg: driver('Database'),
  pymysql: driver('Database'),
  mysqlclient: driver('Database'),
  pymongo: driver('Database'),
  celery: tool('Queue', 'Celery'),
  rq: tool('Queue', 'RQ'),
  dramatiq: tool('Queue', 'Dramatiq'),
  redis: driver('Cache'),
};

/** Go modules match by path prefix (`github.com/jackc/pgx/v5` is `github.com/jackc/pgx`). */
const GO: Readonly<Record<string, Entry>> = {
  'github.com/gin-gonic/gin': tool('API', 'Gin'),
  'github.com/labstack/echo': tool('API', 'Echo'),
  'github.com/gofiber/fiber': tool('API', 'Fiber'),
  'github.com/go-chi/chi': tool('API', 'chi'),
  'github.com/gorilla/mux': tool('API', 'gorilla/mux'),
  'gorm.io/gorm': tool('Database', 'GORM'),
  'github.com/jackc/pgx': driver('Database'),
  'github.com/lib/pq': driver('Database'),
  'github.com/go-sql-driver/mysql': driver('Database'),
  'github.com/hibiken/asynq': tool('Queue', 'Asynq'),
  'github.com/redis/go-redis': driver('Cache'),
  'github.com/go-redis/redis': driver('Cache'),
};

const RUST: Readonly<Record<string, Entry>> = {
  axum: tool('API', 'Axum'),
  'actix-web': tool('API', 'Actix Web'),
  rocket: tool('API', 'Rocket'),
  warp: tool('API', 'Warp'),
  sqlx: tool('Database', 'SQLx'),
  diesel: tool('Database', 'Diesel'),
  'sea-orm': tool('Database', 'SeaORM'),
  redis: driver('Cache'),
};

/** Compose images match by the last path segment of the image name (`bitnami/postgresql` is `postgresql`). */
const COMPOSE: Readonly<Record<string, Entry>> = {
  postgres: engine('Database', 'PostgreSQL'),
  postgresql: engine('Database', 'PostgreSQL'),
  postgis: engine('Database', 'PostgreSQL'),
  mysql: engine('Database', 'MySQL'),
  mariadb: engine('Database', 'MySQL'),
  mongo: engine('Database', 'MongoDB'),
  mongodb: engine('Database', 'MongoDB'),
  redis: engine('Cache', 'Redis'),
  valkey: engine('Cache', 'Redis'),
  memcached: engine('Cache', 'Memcached'),
  rabbitmq: engine('Queue', 'RabbitMQ'),
};

const PRISMA_PROVIDERS: Readonly<Record<string, string>> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  cockroachdb: 'CockroachDB',
};

const lookup = (table: Readonly<Record<string, Entry>>, key: string): Entry | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** `Flask_Login`, `flask.login` and `flask-login` are one package name in Python. */
const pythonName = (raw: string): string => raw.trim().toLowerCase().replace(/[[<>=!~;\s].*$/, '').replaceAll('_', '-').replaceAll('.', '-');
const goEntry = (raw: string): Entry | undefined => {
  const module = raw.trim().toLowerCase();
  const key = Object.keys(GO).find((k) => module === k || module.startsWith(`${k}/`));
  return key === undefined ? undefined : GO[key];
};
const composeEntry = (raw: string): Entry | undefined => lookup(COMPOSE, raw.trim().toLowerCase().split('@')[0]!.split(':')[0]!.split('/').at(-1) ?? '');

const factsOf = (manifest: InventoryManifest, ...keys: string[]): string[] => keys.flatMap((key) => (Object.hasOwn(manifest.facts, key) ? (manifest.facts[key] ?? []) : []));

/** What a manifest names: [fact value, table entry] pairs, reading only the keys the contract documents for its kind. */
const namedBy = (manifest: InventoryManifest): [string, Entry][] => {
  const hits = (values: string[], find: (value: string) => Entry | undefined): [string, Entry][] =>
    values.flatMap((value): [string, Entry][] => {
      const entry = find(value);
      return entry ? [[value.trim(), entry]] : [];
    });
  switch (manifest.kind) {
    case 'npm':
      return hits(factsOf(manifest, 'dependencies', 'devDependencies', 'peerDependencies'), (n) => lookup(NPM, n));
    case 'python':
      return hits(factsOf(manifest, 'packages'), (n) => lookup(PYTHON, pythonName(n)));
    case 'go':
      return hits(factsOf(manifest, 'require'), goEntry);
    case 'rust':
      return hits(factsOf(manifest, 'dependencies'), (n) => lookup(RUST, n.trim().toLowerCase()));
    case 'compose':
      return hits(factsOf(manifest, 'images'), composeEntry);
    default:
      return [];
  }
};

/** Every technology the manifests name, once per manifest. Malformed manifests (no facts) name none. */
export const detectTechnologies = (manifests: readonly InventoryManifest[]): Technology[] => {
  const seen = new Set<string>();
  const out: Technology[] = [];
  const add = (tech: Technology): void => {
    const key = [tech.area, tech.name, tech.role, tech.via, tech.manifestPath].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tech);
  };
  for (const manifest of manifests) {
    if (manifest.kind === 'prisma') {
      const providers = factsOf(manifest, 'provider').map((p) => PRISMA_PROVIDERS[p.trim().toLowerCase()]);
      if (providers.length > 0 || factsOf(manifest, 'models').length > 0) add({ area: 'Database', name: 'Prisma', role: 'tool', via: 'manifest', manifestPath: manifest.path });
      for (const name of providers) if (name) add({ area: 'Database', name, role: 'engine', via: 'provider', manifestPath: manifest.path });
      continue;
    }
    for (const [literal, entry] of namedBy(manifest)) {
      add({ area: entry.area, name: entry.name ?? literal, role: entry.role, via: manifest.kind === 'compose' ? 'compose' : 'manifest', manifestPath: manifest.path });
    }
  }
  return out;
};

const MAX_NAMES = 3;
const IMPLIED_BY = new Map<string, readonly string[]>(Object.values(NPM).filter((e) => e.impliedBy).map((e) => [e.name!, e.impliedBy!]));

const unique = (names: readonly string[]): string[] => [...new Set(names)].sort((a, b) => a.localeCompare(b));

/**
 * The copy for one technology area, e.g. `Database · Prisma (PostgreSQL)`, `Database · pg` or `Cache · Redis (compose)`,
 * from the technologies of that area (others are ignored). Tools come first; drivers only when no tool is named; the
 * engine of a prisma datasource follows in parentheses; engines a compose file declares are listed apart, marked
 * `(compose)`, unless `compose: false` (a compose file is about the whole project, not about one area). Null when there is nothing.
 */
export const describeArea = (area: TechArea, technologies: readonly Technology[], options: { readonly compose?: boolean } = {}): string | null => {
  const ofArea = technologies.filter((t) => t.area === area);
  const present = new Set(ofArea.map((t) => t.name));
  const tools = unique(ofArea.filter((t) => t.role === 'tool' && !IMPLIED_BY.get(t.name)?.some((by) => present.has(by))).map((t) => t.name)).slice(0, MAX_NAMES);
  const head = tools.length > 0 ? tools : unique(ofArea.filter((t) => t.role === 'driver').map((t) => t.name)).slice(0, MAX_NAMES);
  const provided = unique(ofArea.filter((t) => t.role === 'engine' && t.via === 'provider').map((t) => t.name));
  const composed = options.compose === false ? [] : unique(ofArea.filter((t) => t.role === 'engine' && t.via === 'compose').map((t) => t.name)).filter((n) => !provided.includes(n));
  const named = head.length > 0 ? `${head.join(', ')}${provided.length > 0 ? ` (${provided.join(', ')})` : ''}` : provided.join(', ');
  const parts = [named, composed.length > 0 ? `${composed.join(', ')} (compose)` : ''].filter((p) => p !== '');
  return parts.length > 0 ? `${area} · ${parts.join('; ')}` : null;
};
