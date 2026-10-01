import type { RiskKind } from '../session/model/script';

/**
 * Path-name heuristics shared by the classifier and the notices. They look at names only, never at
 * file contents, and a match means "this file looks like X", not that anything was executed.
 */

const segmentsOf = (path: string): string[] => path.toLowerCase().split('/').filter(Boolean);
const baseName = (path: string): string => segmentsOf(path).at(-1) ?? '';

const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.toml',
  'cargo.lock',
  'pyproject.toml',
  'poetry.lock',
  'go.mod',
  'go.sum',
]);

/** Dependency manifests and lockfiles (changing one is not the same as installing). */
export const isDependencyManifest = (path: string): boolean => {
  const name = baseName(path);
  return MANIFEST_NAMES.has(name) || /^requirements.*\.txt$/.test(name);
};

/** `.env*`, `*.config.*`, tsconfig, settings files and tool rc files. */
export const isConfigFile = (path: string): boolean => {
  const name = baseName(path);
  return (
    /^\.env(\..+)?$/.test(name) ||
    /\.config\.[a-z0-9]+$/.test(name) ||
    /^(ts|js)config(\..+)?\.json$/.test(name) ||
    /^settings(\..+)?\.(json|ya?ml|toml)$/.test(name) ||
    /^\.[a-z0-9]+rc(\..+)?$/.test(name)
  );
};

/** Files in a `migrations` directory, or `.sql` files under a `db`/`database` directory. A file, not an executed migration. */
export const isMigrationPath = (path: string): boolean => {
  const directories = segmentsOf(path).slice(0, -1);
  if (directories.includes('migrations')) return true;
  return baseName(path).endsWith('.sql') && directories.some((d) => d === 'db' || d === 'database');
};

/** The factual notice a path deserves, if any. A path gets at most one: migration, then dependency, then config. */
export const noticeKindForPath = (path: string): Exclude<RiskKind, 'outOfScope'> | null => {
  if (isMigrationPath(path)) return 'migration';
  if (isDependencyManifest(path)) return 'dependency';
  if (isConfigFile(path)) return 'config';
  return null;
};
