import type { SystemKind } from '../architecture/model/types';
import { OUTSIDE_PROJECT } from '../ingest/raioEvent';
import { CONFIG_GROUP, type ClassifyContext, classifyPath, MAX_GROUPS, OTHER_GROUP, type PathGroup, ROOT_GROUP } from './classifyPath';
import type { InventoryManifest, ProjectInventory } from './projectInventory';
import { AREA_OF_KIND, describeArea, detectTechnologies, KIND_OF_AREA, NEXT_JS, TECH_AREAS, type Technology } from './technologies';

/** The areas of a whole project, ranked for the map, with the copy about the technologies its manifests name. */
export interface InventoryMap {
  /**
   * The 12 largest areas of the listing (by file count, ties by name) plus `Other` when some areas did not fit. Which
   * areas a session touched never changes the 12, so nothing moves between sessions of the same listing. The areas a
   * session touched that did not fit are listed in `Other.members`.
   */
  readonly groups: readonly PathGroup[];
  /** The area a path belongs to on this map: folded areas answer `Other`; a path on no area answers its own (unmapped) group. */
  readonly classify: (path: string) => PathGroup;
  /** One line per technology area the manifests name, e.g. `Database · Prisma (PostgreSQL)`. Names only; some have no area on the map. */
  readonly technologies: readonly string[];
}

interface Analysis {
  readonly base: (path: string) => PathGroup;
  /** Every area of the listing, with its refined kind and hint; the untouched loose root files are not an area. */
  readonly byId: ReadonlyMap<string, PathGroup>;
  /** The listing's areas, largest first. */
  readonly ranked: readonly PathGroup[];
  readonly technologies: readonly string[];
  /** Maps already built for this listing, by the touched areas that are not among the kept ones. */
  readonly maps: Map<string, InventoryMap>;
}

const MAPS_PER_INVENTORY = 16;
const BACKEND_EXTENSIONS = new Set(['py', 'go', 'java', 'kt', 'cs', 'rb', 'php', 'rs', 'ex', 'scala']);
const FRONTEND_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte']);
const DJANGO_API_FILES = new Set(['views.py', 'urls.py', 'serializers.py']);
/** Folder names that only mean a database or a queue in a backend language layout (not Redux `store`, TS `models`, gulp `tasks`). */
const BACKEND_KIND_BY_NAME: Readonly<Record<string, SystemKind>> = { models: 'database', store: 'database', entities: 'database', repository: 'database', repositories: 'database', tasks: 'jobs' };
const ASSET_FOLDERS = new Set(['static', 'public', 'assets']);

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase();
const extensionOf = (path: string): string => {
  const name = baseName(path);
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
};
const lastSegment = (groupId: string): string => groupId.slice(groupId.lastIndexOf('/') + 1);
const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const isUnder = (file: string, dir: string): boolean => file.startsWith(`${dir}/`);

/** Workspace folders the root `package.json` declares: `libs/*` makes `libs` a package root, `tools/cli` a package. */
const workspaceContext = (manifests: readonly InventoryManifest[]): Required<ClassifyContext> => {
  const packageRoots = new Set<string>();
  const packageDirs = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.kind !== 'npm' || manifest.path !== 'package.json') continue;
    for (const raw of manifest.facts.workspaces ?? []) {
      const glob = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      const wildcard = glob.match(/^([^*]+)\/\*\*?$/);
      if (wildcard) packageRoots.add(wildcard[1]!);
      else if (!glob.includes('*') && glob.includes('/')) packageDirs.add(glob);
    }
  }
  return { packageRoots: [...packageRoots].sort(), packageDirs: [...packageDirs].sort() };
};

/** Whether most of the source files of a group are in a backend language. */
const isBackendLayout = (files: readonly string[]): boolean => {
  const backend = files.filter((f) => BACKEND_EXTENSIONS.has(extensionOf(f))).length;
  const frontend = files.filter((f) => FRONTEND_EXTENSIONS.has(extensionOf(f))).length;
  return backend > 0 && backend >= frontend;
};

/**
 * The kind of a group where its name alone is not enough, from names only. A folder called `app` that is mostly Python
 * is the backend package; `models`, `store`, `entities`, `repositories` and `tasks` mean a database or a queue only in a
 * backend language layout; a package's own manifest naming a frontend or API framework gives the package (and its
 * `src`) that kind; and a Django-style layout (`settings.py` is configuration, `views.py`/`urls.py` an API, `models.py`
 * alone a database) says the rest.
 */
const refineKind = (group: PathGroup, files: readonly string[], ownTechnologies: readonly Technology[]): SystemKind => {
  const name = lastSegment(group.groupId);
  if (group.groupId === 'app' && group.kind === 'frontend') {
    const python = files.filter((f) => extensionOf(f) === 'py').length;
    const scripts = files.filter((f) => FRONTEND_EXTENSIONS.has(extensionOf(f))).length;
    return python > scripts ? 'api' : group.kind;
  }
  const scoped = BACKEND_KIND_BY_NAME[name];
  if (scoped && (group.kind === 'other' || group.kind === scoped)) return isBackendLayout(files) ? scoped : 'other';
  if (group.kind !== 'other' || name === 'tests') return group.kind;
  const fromManifest = (['Frontend', 'API'] as const).find((area) => ownTechnologies.some((t) => t.area === area));
  if (fromManifest) return KIND_OF_AREA[fromManifest]!;
  const names = new Set(files.map(baseName));
  if (names.has('settings.py')) return 'config';
  if ([...names].some((n) => DJANGO_API_FILES.has(n))) return 'api';
  if (names.has('models.py')) return 'database';
  return group.kind;
};

const analyse = (inventory: ProjectInventory): Analysis => {
  const context = workspaceContext(inventory.manifests);
  const base = (path: string): PathGroup => {
    const first = path.replaceAll('\\', '/').split('/').find((s) => s !== '' && s !== '.');
    // CI and editor folders (`.github`, `.vscode`) are configuration, not areas named after a dot.
    if (path !== OUTSIDE_PROJECT && first?.startsWith('.') && path.includes('/')) return CONFIG_GROUP;
    return classifyPath(path, context);
  };

  const filesOf = new Map<string, string[]>();
  const named = new Map<string, PathGroup>();
  for (const file of new Set(inventory.files)) {
    const group = base(file);
    named.set(group.groupId, group);
    const files = filesOf.get(group.groupId);
    if (files) files.push(file);
    else filesOf.set(group.groupId, [file]);
  }

  const technologies = detectTechnologies(inventory.manifests);
  const dirOf = (t: Technology): string => directoryOf(t.manifestPath);
  /** The technologies of a manifest that lives in the folder an area is the package of (the package folder, or its `src`). */
  const ownTechnologies = (groupId: string): Technology[] => technologies.filter((t) => dirOf(t) !== '' && (dirOf(t).toLowerCase() === groupId || `${dirOf(t).toLowerCase()}/src` === groupId));

  const byId = new Map<string, PathGroup>();
  const counts = new Map<string, number>();
  for (const [id, group] of named) {
    const files = filesOf.get(id) ?? [];
    const kind = refineKind(group, files, ownTechnologies(id));
    const area = AREA_OF_KIND[kind];
    const name = lastSegment(id);
    let hint: string | null = null;
    if (area && name !== 'migrations' && !ASSET_FOLDERS.has(name)) {
      // A root manifest is about every area of the matching kind; a manifest inside a folder, about the areas that hold files there.
      const applicable = technologies.filter((t) => t.area === area && (dirOf(t) === '' || files.some((f) => isUnder(f, dirOf(t)))));
      const nextRoutes = area === 'API' && files.some((f) => /(^|\/)(app|pages)\/api\//.test(f));
      const nextJs = technologies.find((t) => t.name === NEXT_JS && (dirOf(t) === '' || files.some((f) => isUnder(f, dirOf(t)))));
      hint = describeArea(area, nextRoutes && nextJs ? [...applicable, { ...nextJs, area: 'API' }] : applicable, { compose: false });
    }
    byId.set(id, { groupId: id, label: group.label, kind, ...(hint ? { hint } : {}) });
    counts.set(id, files.length);
  }

  const compare = (a: PathGroup, b: PathGroup): number => (counts.get(b.groupId) ?? 0) - (counts.get(a.groupId) ?? 0) || a.label.localeCompare(b.label) || a.groupId.localeCompare(b.groupId);
  const ranked = [...byId.values()].filter((g) => g.groupId !== ROOT_GROUP.groupId).sort(compare);

  const lines = TECH_AREAS.map((area) => describeArea(area, technologies)).filter((line): line is string => line !== null);
  return { base, byId, ranked, technologies: lines, maps: new Map() };
};

const analyses = new WeakMap<ProjectInventory, Analysis>();
const analysisOf = (inventory: ProjectInventory): Analysis => {
  let analysis = analyses.get(inventory);
  if (!analysis) analyses.set(inventory, (analysis = analyse(inventory)));
  return analysis;
};

/**
 * The areas of the whole project from the core's inventory (a heuristic from folder names and manifest names, see
 * `HEURISTIC_NOTE`). The map keeps the 12 largest areas of the listing (by file count, ties by name) and folds the
 * rest into `Other`; the areas `touchedPaths` fall in never change that, so positions stay the same between sessions
 * of the same listing. A touched area that did not fit, or that the listing does not hold at all (created since,
 * outside the project, a loose root file), is shown inside `Other`, which lists it (`members`), whatever the number
 * of areas. Pure in (inventory, touched areas outside the kept ones), and memoised on them: the same ones return the same object, whose `classify` the import edges are
 * memoised by, so a projection per event does not re-derive them.
 */
export const groupInventory = (inventory: ProjectInventory, touchedPaths: Iterable<string> = []): InventoryMap => {
  const analysis = analysisOf(inventory);
  const groupOf = (path: string): PathGroup => {
    const base = analysis.base(path);
    return analysis.byId.get(base.groupId) ?? base;
  };

  const kept = analysis.ranked.slice(0, MAX_GROUPS);
  const keptIds = new Set(kept.map((g) => g.groupId));
  const touchedOutside = new Map<string, PathGroup>();
  for (const path of touchedPaths) {
    const group = groupOf(path);
    if (!keptIds.has(group.groupId)) touchedOutside.set(group.groupId, group);
  }
  const key = [...touchedOutside.keys()].sort().join('\u0001');
  const cached = analysis.maps.get(key);
  if (cached) return cached;

  const foldedIds = new Set([...analysis.ranked.slice(MAX_GROUPS).map((g) => g.groupId), ...touchedOutside.keys()]);
  const members = [...new Set([...touchedOutside.values()].map((g) => g.label))].sort((a, b) => a.localeCompare(b));
  const other: PathGroup = members.length > 0 ? { ...OTHER_GROUP, members } : OTHER_GROUP;

  const classify = (path: string): PathGroup => {
    const group = groupOf(path);
    if (keptIds.has(group.groupId)) return analysis.byId.get(group.groupId) ?? group;
    return foldedIds.has(group.groupId) ? other : group;
  };

  const map: InventoryMap = { groups: foldedIds.size > 0 ? [...kept, other] : kept, classify, technologies: analysis.technologies };
  if (analysis.maps.size >= MAPS_PER_INVENTORY) analysis.maps.delete(analysis.maps.keys().next().value!);
  analysis.maps.set(key, map);
  return map;
};

/** The sentences the evidence copy adds about the inventory: how complete the listing is. The technologies are listed apart. */
export const inventoryNotes = (inventory: ProjectInventory, options: { readonly stale?: boolean } = {}): string[] => {
  const notes: string[] = [];
  if (options.stale) notes.push('The latest relisting failed, so these areas are as of the last listing.');
  if (inventory.truncated) notes.push('The project listing was partial, so some areas may be missing.');
  if (inventory.skipped > 0) {
    const n = inventory.skipped;
    notes.push(`${n} ${n === 1 ? 'file or folder' : 'files or folders'} not listed (large, unreadable or online-only).`);
  }
  return notes;
};
