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
}

const MONOREPO_ROOTS = new Set(['apps', 'packages', 'services']);
const SOURCE_ROOTS = new Set(['src', 'lib']);
const TEST_NAMES = new Set(['test', 'tests', '__tests__', 'spec']);

const KIND_BY_NAME: Readonly<Record<string, SystemKind>> = {
  web: 'frontend',
  frontend: 'frontend',
  client: 'frontend',
  app: 'frontend',
  components: 'frontend',
  pages: 'frontend',
  api: 'api',
  server: 'api',
  routes: 'api',
  handlers: 'api',
  auth: 'auth',
  db: 'database',
  database: 'database',
  prisma: 'database',
  migrations: 'database',
  models: 'database',
  schema: 'database',
  payments: 'payments',
  billing: 'payments',
  storage: 'storage',
  uploads: 'storage',
  s3: 'storage',
  config: 'config',
  jobs: 'jobs',
  workers: 'jobs',
  queues: 'jobs',
};

const LABEL_OVERRIDES: Readonly<Record<string, string>> = { api: 'API', db: 'DB', s3: 'S3' };

const TESTS_GROUP: PathGroup = { groupId: 'tests', label: 'Tests', kind: 'other' };
const CONFIG_GROUP: PathGroup = { groupId: 'config', label: 'Config', kind: 'config' };
const ROOT_GROUP: PathGroup = { groupId: 'project-root', label: 'Project root', kind: 'other' };
const OUTSIDE_GROUP: PathGroup = { groupId: OUTSIDE_PROJECT, label: 'Outside project', kind: 'other' };
export const OTHER_GROUP: PathGroup = { groupId: 'merged-other', label: 'Other', kind: 'other' };

const capitalise = (name: string): string => LABEL_OVERRIDES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);

const directoryGroup = (segment: string): PathGroup => {
  const name = segment.toLowerCase();
  if (TEST_NAMES.has(name)) return TESTS_GROUP;
  return { groupId: name, label: capitalise(name), kind: KIND_BY_NAME[name] ?? 'other' };
};

/**
 * Heuristic group of a project-relative POSIX path, decided from names only (see HEURISTIC_NOTE).
 * Order: outside-project, root files, monorepo package, `src/`|`lib/` + next segment, top-level directory.
 * Config and manifest names only count at the project root; inside a package or folder the file
 * stays with its neighbours (the notice for it is derived separately from the path).
 */
export const classifyPath = (path: string): PathGroup => {
  if (path === OUTSIDE_PROJECT) return OUTSIDE_GROUP;
  const segments = path.replaceAll('\\', '/').split('/').filter((s) => s !== '' && s !== '.');
  const first = segments[0];
  if (first === undefined) return ROOT_GROUP;
  if (segments.length === 1) return isConfigFile(first) || isDependencyManifest(first) ? CONFIG_GROUP : ROOT_GROUP;

  const root = first.toLowerCase();
  const second = segments[1];
  if (MONOREPO_ROOTS.has(root) && second !== undefined && segments.length >= 3) {
    return { groupId: `${root}/${second.toLowerCase()}`, label: second, kind: KIND_BY_NAME[second.toLowerCase()] ?? 'other' };
  }
  if (SOURCE_ROOTS.has(root) && second !== undefined && segments.length >= 3) return directoryGroup(second);
  return directoryGroup(first);
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
