import type { SystemKind } from '../architecture/model/types';
import { OUTSIDE_PROJECT } from '../ingest/raioEvent';
import { isConfigFile, isDependencyManifest } from './pathKinds';

/** Shown wherever groups are presented: the grouping is a guess from folder names, not verified structure. */
export const HEURISTIC_NOTE = 'Groups are a heuristic guess from folder names, not verified dependencies. Relationships between groups are unknown.';

export const MAX_GROUPS = 12;

export interface PathGroup {
  readonly groupId: string;
  readonly label: string;
  readonly kind: SystemKind;
  /** Technology named by the project's manifests for this area, e.g. `API · Express`. A heuristic, never read from code. */
  readonly hint?: string;
  /** Only on `Other`: the labels of the areas a session touched that did not fit among the 12 and are inside it. */
  readonly members?: readonly string[];
}

/** Folders the project itself declares as packages (npm workspaces), on top of the conventional `apps`, `packages` and `services`. */
export interface ClassifyContext {
  /** Directories whose children are packages, e.g. `libs` from the workspace glob `libs/*`. */
  readonly packageRoots?: readonly string[];
  /** Directories that are a package themselves, e.g. `tools/cli` from the workspace entry `tools/cli`. */
  readonly packageDirs?: readonly string[];
}

const MONOREPO_ROOTS = ['apps', 'packages', 'services'];
const SOURCE_ROOTS = new Set(['src', 'lib', 'internal', 'pkg']);
const NEXT_ROUTE_ROOTS = new Set(['app', 'pages']);
const TEST_NAMES = new Set(['test', 'tests', '__tests__', 'spec']);
const CLIENT_MODULE = /_client\.(py|go|java|kt|cs|rb|php|rs|ex|scala|ts|tsx|js|jsx|mjs|cjs)$/i;

const KIND_BY_NAME: Readonly<Record<string, SystemKind>> = {
  web: 'frontend',
  frontend: 'frontend',
  client: 'frontend',
  app: 'frontend',
  components: 'frontend',
  pages: 'frontend',
  templates: 'frontend',
  static: 'frontend',
  public: 'frontend',
  assets: 'frontend',
  api: 'api',
  server: 'api',
  backend: 'api',
  routes: 'api',
  routers: 'api',
  controllers: 'api',
  endpoints: 'api',
  handlers: 'api',
  auth: 'auth',
  db: 'database',
  database: 'database',
  prisma: 'database',
  migrations: 'database',
  models: 'database',
  schema: 'database',
  alembic: 'database',
  supabase: 'database',
  payments: 'payments',
  billing: 'payments',
  storage: 'storage',
  uploads: 'storage',
  s3: 'storage',
  config: 'config',
  infra: 'config',
  deploy: 'config',
  terraform: 'config',
  jobs: 'jobs',
  workers: 'jobs',
  worker: 'jobs',
  queues: 'jobs',
  queue: 'jobs',
};

const LABEL_OVERRIDES: Readonly<Record<string, string>> = { api: 'API', db: 'DB', s3: 'S3' };

const TESTS_GROUP: PathGroup = { groupId: 'tests', label: 'Tests', kind: 'other' };
export const CONFIG_GROUP: PathGroup = { groupId: 'config', label: 'Config', kind: 'config' };
export const ROOT_GROUP: PathGroup = { groupId: 'project-root', label: 'Project root', kind: 'other' };
const OUTSIDE_GROUP: PathGroup = { groupId: OUTSIDE_PROJECT, label: 'Outside project', kind: 'other' };
export const OTHER_GROUP: PathGroup = { groupId: 'merged-other', label: 'Other', kind: 'other' };

const capitalise = (name: string): string => LABEL_OVERRIDES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

const directoryGroup = (segment: string): PathGroup => {
  const name = segment.toLowerCase();
  if (TEST_NAMES.has(name)) return TESTS_GROUP;
  return { groupId: name, label: capitalise(name), kind: KIND_BY_NAME[name] ?? 'other' };
};

/** `Dockerfile` and `docker-compose*.y(a)ml` / `compose*.y(a)ml` at the project root count as configuration. */
const isInfraFile = (name: string): boolean => /^(docker-compose|compose)(\..+)?\.ya?ml$/i.test(name) || /^dockerfile(\..+)?$/i.test(name);
const directorySegments = (dir: string): string[] => dir.toLowerCase().split('/').filter((s) => s !== '' && s !== '.');
const startsWith = (segments: readonly string[], prefix: readonly string[]): boolean => prefix.every((p, i) => segments[i]?.toLowerCase() === p);

/**
 * The area of a path inside a folder (a project, or one workspace package), by names only: Next.js route handlers
 * (`app/api`, `pages/api`, also under `src/`), `src/`|`lib/`|`internal/`|`pkg/` + next segment, Python `app/<package>/`,
 * a `migrations` folder inside an app (its own Database area), then the top-level directory. Needs at least two segments.
 * `cmd/` is deliberately not split: every entry point is one `Cmd` area.
 */
const classifyFolder = (segments: readonly string[]): PathGroup => {
  const first = segments[0]!;
  const root = first.toLowerCase();
  const second = segments[1];

  // Frontend subprojects keep their tests separate; Python app templates are an interface, not API code.
  if (TEST_NAMES.has(root) || (['frontend', 'client', 'web'].includes(root) && TEST_NAMES.has(second?.toLowerCase() ?? ''))) return TESTS_GROUP;
  if (root === 'app' && segments.slice(1, -1).some((s) => s.toLowerCase() === 'templates')) return directoryGroup('templates');
  // A client module is only a name-based integration hint, never evidence of a runtime connection.
  if (CLIENT_MODULE.test(segments.at(-1)!) && !segments.slice(0, -1).some((s) => TEST_NAMES.has(s.toLowerCase())) && !/^test_/i.test(segments.at(-1)!)) return directoryGroup('integrations');

  const routes = (root === 'src' ? segments.slice(1) : segments).map((s) => s.toLowerCase());
  if (NEXT_ROUTE_ROOTS.has(routes[0] ?? '') && routes[1] === 'api' && routes.length >= 3) return directoryGroup('api');

  if (SOURCE_ROOTS.has(root) && second !== undefined && segments.length >= 3) return directoryGroup(second);
  if (root === 'app' && second !== undefined && segments.length >= 3 && /\.py$/i.test(segments.at(-1)!)) return directoryGroup(second);
  const top = directoryGroup(first);
  if (second?.toLowerCase() === 'migrations' && segments.length >= 3 && top.kind !== 'database' && top !== TESTS_GROUP) {
    return { groupId: `${root}/migrations`, label: `${first}/migrations`, kind: 'database' };
  }
  return top;
};

/**
 * Heuristic group of a project-relative POSIX path, decided from names only (see HEURISTIC_NOTE).
 * Order: outside-project, root files, workspace package (conventional `apps`/`packages`/`services`, or declared by the
 * project), then the layout of the folder (see `classifyFolder`). Inside a package the same layout rules apply to the
 * path relative to the package, so `apps/web/app/api` is the API area of `web` and `apps/web/components` another;
 * the area is named after the package (`web/API`). A package's manifest and config files go to Config, its loose
 * source files to the package itself, and `src/` files to a `src` area that takes the package's kind.
 * Config, manifest and Docker/compose names only count at the project root (or a package root); inside a folder the
 * file stays with its neighbours (the notice for it is derived separately from the path).
 * The group id alone decides the kind, never the file inside it, so grouping stays independent of the order of paths.
 */
export const classifyPath = (path: string, context: ClassifyContext = {}): PathGroup => {
  if (path === OUTSIDE_PROJECT) return OUTSIDE_GROUP;
  const segments = path.replaceAll('\\', '/').split('/').filter((s) => s !== '' && s !== '.');
  const first = segments[0];
  if (first === undefined) return ROOT_GROUP;
  if (segments.length === 1) return isConfigFile(first) || isDependencyManifest(first) || isInfraFile(first) ? CONFIG_GROUP : ROOT_GROUP;

  let pack: { readonly id: string; readonly name: string; readonly depth: number } | null = null;
  for (const dir of [...MONOREPO_ROOTS, ...(context.packageRoots ?? [])]) {
    const prefix = directorySegments(dir);
    if (prefix.length > 0 && segments.length >= prefix.length + 2 && startsWith(segments, prefix) && (!pack || prefix.length + 1 > pack.depth)) {
      const name = segments[prefix.length]!;
      pack = { id: `${prefix.join('/')}/${name.toLowerCase()}`, name, depth: prefix.length + 1 };
    }
  }
  for (const dir of context.packageDirs ?? []) {
    const prefix = directorySegments(dir);
    if (prefix.length > 1 && segments.length > prefix.length && startsWith(segments, prefix) && (!pack || prefix.length > pack.depth)) {
      pack = { id: prefix.join('/'), name: segments[prefix.length - 1]!, depth: prefix.length };
    }
  }
  if (!pack) return classifyFolder(segments);

  const kind = KIND_BY_NAME[pack.name.toLowerCase()] ?? 'other';
  const rest = segments.slice(pack.depth);
  if (rest.length === 1) return isConfigFile(rest[0]!) || isDependencyManifest(rest[0]!) || isInfraFile(rest[0]!) ? CONFIG_GROUP : { groupId: pack.id, label: pack.name, kind };
  const inner = classifyFolder(rest);
  return { groupId: `${pack.id}/${inner.groupId}`, label: `${pack.name}/${inner.label}`, kind: inner.groupId === 'src' && inner.kind === 'other' ? kind : inner.kind };
};

/** Groups of a path set with a path-to-group lookup, capped at MAX_GROUPS plus an `Other` group. Order-independent. */
export const groupPaths = (paths: Iterable<string>): { readonly groups: readonly PathGroup[]; readonly groupOf: ReadonlyMap<string, PathGroup> } => {
  const byPath = new Map<string, PathGroup>();
  const pathCount = new Map<string, number>();
  const known = new Map<string, PathGroup>();
  for (const path of new Set(paths)) {
    const group = classifyPath(path);
    byPath.set(path, group);
    known.set(group.groupId, group);
    pathCount.set(group.groupId, (pathCount.get(group.groupId) ?? 0) + 1);
  }
  const ranked = [...known.values()].sort((a, b) => (pathCount.get(b.groupId) ?? 0) - (pathCount.get(a.groupId) ?? 0) || a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId));
  if (ranked.length <= MAX_GROUPS) return { groups: ranked, groupOf: byPath };

  const kept = new Set(ranked.slice(0, MAX_GROUPS).map((g) => g.groupId));
  const groupOf = new Map<string, PathGroup>();
  for (const [path, group] of byPath) groupOf.set(path, kept.has(group.groupId) ? group : OTHER_GROUP);
  return { groups: [...ranked.slice(0, MAX_GROUPS), OTHER_GROUP], groupOf };
};
