export type ManifestKind = 'npm' | 'python' | 'go' | 'rust' | 'compose' | 'prisma' | 'other';

/**
 * One dependency/infrastructure manifest the core recognised. `facts` are NAMES ONLY, never values or versions, under
 * exactly these keys (a missing fact omits its key; a manifest the core could not parse arrives with empty facts):
 * - npm: `dependencies`, `devDependencies`, `peerDependencies`, `workspaces` (globs), `scripts` (names)
 * - python: `packages`
 * - go: `module` (one item), `require`
 * - rust: `dependencies`, `members`
 * - compose: `services`, `images` (without tag)
 * - prisma: `provider` (one item), `models`
 * - other: none
 */
export interface InventoryManifest {
  readonly path: string;
  readonly kind: ManifestKind;
  readonly facts: Readonly<Record<string, readonly string[]>>;
}

/** What the core's `project_inventory` returns: the project's file paths and the names its manifests state. Never file contents. */
export interface ProjectInventory {
  /** Project-relative POSIX paths, under the watcher's ignore rules. */
  readonly files: readonly string[];
  /** The listing hit a cap (file count or time) and stopped early. */
  readonly truncated: boolean;
  /** Files or folders not listed: unreadable, symlinks, or online-only cloud placeholders. */
  readonly skipped: number;
  readonly scannedAtMs: number;
  readonly manifests: readonly InventoryManifest[];
}

/** The core caps its listing at 20 000 paths; a payload far beyond that is not the contract and is not held. */
const MAX_FILES = 50_000;
const KINDS: ReadonlySet<string> = new Set<ManifestKind>(['npm', 'python', 'go', 'rust', 'compose', 'prisma', 'other']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
/**
 * A project-relative path: not a drive path, not rooted (an absolute path would leak a personal location) and never
 * climbing out of the project with a `..` segment.
 */
const isRelativePath = (value: unknown): value is string =>
  typeof value === 'string' && !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..');

const isManifest = (value: unknown): boolean =>
  isRecord(value) && isRelativePath(value.path) && typeof value.kind === 'string' && KINDS.has(value.kind) && isRecord(value.facts) && Object.values(value.facts).every(isStrings);

/** Guards the shape the core returns; anything else is treated as "no inventory" and the map falls back to the session's paths. */
export const isProjectInventory = (value: unknown): value is ProjectInventory =>
  isRecord(value) &&
  Array.isArray(value.files) &&
  value.files.length <= MAX_FILES &&
  value.files.every(isRelativePath) &&
  typeof value.truncated === 'boolean' &&
  isCount(value.skipped) &&
  typeof value.scannedAtMs === 'number' &&
  Array.isArray(value.manifests) &&
  value.manifests.every(isManifest);
