import { classifyPath, HEURISTIC_NOTE, OTHER_GROUP } from './classifyPath';

/** One scanned TS/JS file: its project-relative POSIX path and the string-literal sources it imports (facts only). */
export interface ImportFile {
  readonly path: string;
  readonly specifiers: readonly string[];
}

/** What the core's `project_imports` returns. Paths and specifiers only; never file contents. */
export interface ProjectImports {
  readonly files: readonly ImportFile[];
  /** The scan hit a cap (file count or time) and stopped early. */
  readonly truncated: boolean;
  /** Files or folders not read: larger than 512 KiB, unreadable, or online-only cloud placeholders. */
  readonly skipped: number;
  readonly scannedAtMs: number;
}

/** A static import relation between two groups, importer to imported, with how many specifiers back it. */
export interface GroupImportEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

export interface ImportEdgeResult {
  readonly edges: readonly GroupImportEdge[];
  /** The scan found at least one TS/JS file; otherwise relationships stay unknown. */
  readonly hasScriptFiles: boolean;
  /** Specifiers that did not resolve to a scanned file (packages, aliases, missing or non-script targets). */
  readonly unresolved: number;
  readonly truncated: boolean;
  readonly skipped: number;
}

/** What the map knows about relationships: nothing, or static imports between areas (a heuristic). */
export type Relationships = 'unknown' | StaticImportRelationships;

export interface StaticImportRelationships {
  readonly kind: 'static-imports';
  /** Lines between groups on the map (one per pair of areas). */
  readonly edges: number;
  /** Specifiers behind those edges. */
  readonly imports: number;
  readonly unresolved: number;
  readonly truncated: boolean;
  readonly skipped: number;
  /** A rescan after file activity failed: these relationships are as of the last scan that worked. */
  readonly stale?: true;
}

const EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] as const;

/** `./x`, `../x`, `.` and `..` are relative; `.hidden` and `..foo` are names, not paths. */
const isRelative = (specifier: string): boolean => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

/** `?query` and `#hash` are not part of the file a specifier names. */
const withoutSuffix = (specifier: string): string => specifier.replace(/[?#][\s\S]*$/, '');

const namesDirectory = (specifier: string): boolean => specifier === '.' || specifier === '..' || /(^|\/)\.{0,2}$/.test(specifier);

const toPosix = (path: string): string => path.replaceAll('\\', '/');

/** Joins a directory and a relative specifier into a normalised project path (`''` is the root), or null when it climbs above the root. */
const joinRelative = (directory: string, specifier: string): string | null => {
  const parts = directory === '' ? [] : directory.split('/');
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
};

const directoryOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** TypeScript's own source-extension substitution (NodeNext/ESM): a `.js` import names the `.ts` source. */
const SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/**
 * The scanned file a relative specifier names: the exact path, then the source-extension substitution, then each
 * extension, then `/index.<extension>`. Looks in the scanned set only, never on disk.
 */
const resolveRelative = (importer: string, specifier: string, known: ReadonlySet<string>): string | null => {
  const target = joinRelative(directoryOf(importer), specifier);
  if (target === null) return null;
  const prefix = target === '' ? '' : `${target}/`;
  // `.`, `..`, `x/`, `x/.` and `x/..` name a directory: only its index counts, never a sibling file `x.ts`.
  if (target !== '' && !namesDirectory(specifier)) {
    if (known.has(target)) return target;
    const dot = target.lastIndexOf('.');
    const swaps = dot > target.lastIndexOf('/') ? (SOURCE_EXTENSIONS[target.slice(dot)] ?? []) : [];
    for (const ext of swaps) if (known.has(`${target.slice(0, dot)}${ext}`)) return `${target.slice(0, dot)}${ext}`;
    for (const ext of EXTENSIONS) if (known.has(`${target}.${ext}`)) return `${target}.${ext}`;
  }
  for (const ext of EXTENSIONS) if (known.has(`${prefix}index.${ext}`)) return `${prefix}index.${ext}`;
  return null;
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Static import relations between groups from scanned import facts (a heuristic, see `relationshipsNote`).
 * Only relative specifiers are resolved, against the scanned file set; bare specifiers and aliases count
 * as unresolved (no tsconfig paths in v1). `groupOf` returns a path's group on the map, or null when the
 * path is not on the map: such imports make no edge and are not counted. One edge per ordered pair of
 * distinct groups; self-group imports are not edges. Output order is independent of the scan order.
 */
export const deriveImportEdges = (imports: ProjectImports, groupOf: (path: string) => string | null): ImportEdgeResult => {
  const files = imports.files.map((f) => ({ path: toPosix(f.path), specifiers: f.specifiers }));
  const known = new Set(files.map((f) => f.path));
  const counts = new Map<string, { from: string; to: string; count: number }>();
  let unresolved = 0;
  for (const file of files) {
    const from = groupOf(file.path);
    if (from === null) continue;
    for (const raw of file.specifiers) {
      const specifier = withoutSuffix(raw);
      const resolved = isRelative(specifier) ? resolveRelative(file.path, specifier, known) : null;
      if (resolved === null) {
        unresolved++;
        continue;
      }
      const to = groupOf(resolved);
      if (to === null || to === from) continue;
      const key = `${from}\u0000${to}`;
      const edge = counts.get(key);
      if (edge) edge.count++;
      else counts.set(key, { from, to, count: 1 });
    }
  }
  const edges = [...counts.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
  return { edges, hasScriptFiles: files.length > 0, unresolved, truncated: imports.truncated, skipped: imports.skipped };
};

/**
 * The lines the map draws: ONE per unordered pair of areas, kept in the direction with more imports (a tie goes to the
 * alphabetically first importer), so travel and pulses follow the stronger relationship. Sorted like the edges.
 */
export const drawnLinks = (edges: readonly GroupImportEdge[]): { readonly from: string; readonly to: string }[] => {
  const best = new Map<string, GroupImportEdge>();
  for (const edge of edges) {
    const key = edge.from < edge.to ? `${edge.from}\u0000${edge.to}` : `${edge.to}\u0000${edge.from}`;
    const current = best.get(key);
    if (!current || edge.count > current.count || (edge.count === current.count && edge.from < current.from)) best.set(key, edge);
  }
  return [...best.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to)).map(({ from, to }) => ({ from, to }));
};

/** The map's group for a scanned path: a group on the map, `Other` for a group merged into it, null for a group the map does not show. */
const mapGroupOf = (mapped: ReadonlySet<string>, touched: ReadonlySet<string>) => (path: string): string | null => {
  const id = classifyPath(path).groupId;
  return mapped.has(id) ? id : touched.has(id) ? OTHER_GROUP.groupId : null;
};

const MEMO_PER_SCAN = 8;
const memo = new WeakMap<ProjectImports, Map<string, ImportEdgeResult>>();
const keyOf = (ids: ReadonlySet<string>): string => [...ids].sort().join('\u0001');

/**
 * `deriveImportEdges` for the groups on the map, memoised by (scan object, group set): the projection runs on every
 * event, the scan changes rarely. `mapped` are the node ids of the map; `touched` the groups the session's paths fall in
 * (those not in `mapped` were merged into Other).
 */
export const deriveMapImportEdges = (imports: ProjectImports, mapped: ReadonlySet<string>, touched: ReadonlySet<string>): ImportEdgeResult => {
  let results = memo.get(imports);
  if (!results) memo.set(imports, (results = new Map()));
  const key = `${keyOf(mapped)}\u0002${keyOf(touched)}`;
  let result = results.get(key);
  if (!result) {
    if (results.size >= MEMO_PER_SCAN) results.delete(results.keys().next().value!);
    result = deriveImportEdges(imports, mapGroupOf(mapped, touched));
    results.set(key, result);
  }
  return result;
};

/** What the evidence panel and map say about relationships, from what the derivation found. */
export const relationshipsFrom = (result: ImportEdgeResult, options: { readonly stale?: boolean } = {}): Relationships =>
  result.hasScriptFiles
    ? {
        kind: 'static-imports',
        edges: drawnLinks(result.edges).length,
        imports: result.edges.reduce((sum, e) => sum + e.count, 0),
        unresolved: result.unresolved,
        truncated: result.truncated,
        skipped: result.skipped,
        ...(options.stale ? { stale: true as const } : {}),
      }
    : 'unknown';

const GROUPS_ARE_HEURISTIC = 'Groups are a heuristic guess from folder names, not verified dependencies.';

/** The map copy for the current relationships knowledge. Unknown keeps the existing wording unchanged. */
export const relationshipsNote = (relationships: Relationships): string => {
  if (relationships === 'unknown') return HEURISTIC_NOTE;
  const parts = [GROUPS_ARE_HEURISTIC, 'Relationships: static imports between areas (heuristic).'];
  if (relationships.unresolved > 0) {
    const n = relationships.unresolved;
    parts.push(`${n} import ${n === 1 ? 'specifier was' : 'specifiers were'} not resolved (packages, aliases, non-script or missing files).`);
  }
  if (relationships.stale) parts.push('The latest rescan failed, so these relationships are as of the last scan.');
  if (relationships.truncated) parts.push('The scan was partial, so some relationships may be missing.');
  if (relationships.skipped > 0) {
    const n = relationships.skipped;
    parts.push(`${n} ${n === 1 ? 'file or folder' : 'files or folders'} not read (large, unreadable or online-only).`);
  }
  return parts.join(' ');
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Guards the shape the core returns; anything else is treated as "relationships unknown". */
export const isProjectImports = (value: unknown): value is ProjectImports =>
  isRecord(value) &&
  Array.isArray(value.files) &&
  value.files.every((f) => isRecord(f) && typeof f.path === 'string' && Array.isArray(f.specifiers) && f.specifiers.every((s) => typeof s === 'string')) &&
  typeof value.truncated === 'boolean' &&
  isCount(value.skipped) &&
  typeof value.scannedAtMs === 'number';
