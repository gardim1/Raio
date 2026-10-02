import { describe, expect, it } from 'vitest';
import { classifyPath } from './classifyPath';
import { deriveImportEdges, deriveMapImportEdges, drawnLinks, type ImportFile, isProjectImports, relationshipsFrom, relationshipsNote } from './importEdges';

const file = (path: string, ...specifiers: string[]): ImportFile => ({ path, specifiers });
const scan = (files: ImportFile[], extra: { truncated?: boolean; skipped?: number } = {}) => ({ files, truncated: false, skipped: 0, scannedAtMs: 1, ...extra });
const GROUPS = new Set(['auth', 'api', 'web', 'db']);
/** Groups by first folder, `null` for anything not on the map. */
const byFolder = (path: string): string | null => {
  const first = path.split('/')[0]!;
  return GROUPS.has(first) ? first : null;
};
const derive = (files: ImportFile[], extra: { truncated?: boolean; skipped?: number } = {}) => deriveImportEdges(scan(files, extra), byFolder);

describe('deriveImportEdges', () => {
  it('has no edges and no static-import claim when there are no TS/JS files', () => {
    const result = derive([]);
    expect(result.edges).toEqual([]);
    expect(result.hasScriptFiles).toBe(false);
    expect(result.unresolved).toBe(0);
  });

  it('creates one directed edge (importer to imported) between distinct groups, with a count', () => {
    const result = derive([file('web/a.ts', '../auth/session'), file('web/b.ts', '../auth/session', '../auth/token'), file('auth/session.ts'), file('auth/token.ts')]);
    expect(result.hasScriptFiles).toBe(true);
    expect(result.edges).toEqual([{ from: 'web', to: 'auth', count: 3 }]);
    expect(result.unresolved).toBe(0);
  });

  it('keeps both directions as separate ordered pairs', () => {
    const result = derive([file('web/a.ts', '../api/x'), file('api/x.ts', '../web/a')]);
    expect(result.edges).toEqual([
      { from: 'api', to: 'web', count: 1 },
      { from: 'web', to: 'api', count: 1 },
    ]);
  });

  it('ignores imports inside the same group', () => {
    const result = derive([file('auth/a.ts', './b', './deep/c'), file('auth/b.ts'), file('auth/deep/c.ts', '../a')]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(0);
  });

  it('resolves ../ across groups from nested folders', () => {
    const result = derive([file('web/pages/deep/a.tsx', '../../../api/routes/users'), file('api/routes/users.ts')]);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
  });

  it('probes the exact path, then extensions in contract order, then index files', () => {
    const files = [
      file('web/a.ts', '../api/exact.json', '../api/ext', '../api/dir', '../api/mixed', '../db/pkg'),
      file('api/exact.json'),
      file('api/ext.mjs'),
      file('api/dir/index.tsx'),
      file('api/mixed.ts'),
      file('api/mixed.js'),
      file('db/pkg/index.cjs'),
    ];
    const result = derive(files);
    expect(result.edges).toEqual([
      { from: 'web', to: 'api', count: 4 },
      { from: 'web', to: 'db', count: 1 },
    ]);
    expect(result.unresolved).toBe(0);
  });

  it('prefers an extension match over an index file, in a deterministic order', () => {
    const files = [file('web/a.ts', '../api/x'), file('api/x.ts'), file('api/x/index.ts')];
    expect(derive(files).edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
    // `x.js` exists only beside the index: the extension probe (ts, tsx, mts, cts, js, ...) finds it before `/index.*`.
    const second = derive([file('web/a.ts', '../db/y'), file('db/y.js'), file('db/y/index.ts')]);
    expect(second.edges).toEqual([{ from: 'web', to: 'db', count: 1 }]);
  });

  it('counts bare specifiers, aliases and unresolvable relative specifiers as unresolved, never as edges', () => {
    const result = derive([
      file('web/a.ts', 'react', '@scope/pkg', '@/auth/session', '~/api', '../auth/missing', './styles.css', 'node:fs'),
      file('auth/session.ts'),
    ]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(7);
  });

  it('never climbs above the project root, even when a file with that name exists at the root', () => {
    const rootGroupOf = (path: string): string | null => (path === 'escape.ts' ? 'db' : byFolder(path));
    const files = [file('web/a.ts', '../../escape', '../../../escape', '../escape'), file('escape.ts')];
    const result = deriveImportEdges(scan(files), rootGroupOf);
    // `../escape` stays inside the project and reaches the root file; the two that climb out do not.
    expect(result.edges).toEqual([{ from: 'web', to: 'db', count: 1 }]);
    expect(result.unresolved).toBe(2);
  });

  it('treats a file importing itself as a self-group import: resolved, no edge, not unresolved', () => {
    const result = derive([file('auth/a.ts', './a', './a.ts')]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(0);
  });

  it('does not treat a lookalike inside the file set as a resolution of a bare specifier', () => {
    const result = derive([file('web/a.ts', 'auth/session'), file('auth/session.ts')]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(1);
  });

  it('does not make an edge for files whose group is not on the map, and does not count them as unresolved', () => {
    const result = derive([file('scripts/tool.ts', '../web/a'), file('web/a.ts', '../scripts/tool'), file('web/b.ts', '../api/x'), file('api/x.ts')]);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
    expect(result.unresolved).toBe(0);
  });

  it('is deterministic: the order of the scan does not change edges, counts or order', () => {
    const files = [file('web/a.ts', '../api/x', '../auth/s'), file('api/x.ts', '../db/d'), file('auth/s.ts'), file('db/d.ts', '../auth/s')];
    const forward = derive(files);
    const backward = derive([...files].reverse());
    expect(backward).toEqual(forward);
    expect(forward.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['api>db', 'db>auth', 'web>api', 'web>auth']);
  });

  it('flags a truncated scan and the files or folders it did not read, without dropping the edges it did find', () => {
    const result = derive([file('web/a.ts', '../api/x'), file('api/x.ts')], { truncated: true, skipped: 3 });
    expect(result.truncated).toBe(true);
    expect(result.skipped).toBe(3);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
    expect(derive([]).truncated).toBe(false);
  });

  it('resolves against the scanned file set only, never the disk', () => {
    const result = derive([file('web/a.ts', '../api/x')]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toBe(1);
  });

  it('works with the real path classifier as the group lookup', () => {
    const files = [file('src/web/app.ts', '../auth/login'), file('src/auth/login.ts'), file('packages/core/a.ts', '../../src/auth/login')];
    const result = deriveImportEdges(scan(files), (p) => classifyPath(p).groupId);
    expect(result.edges).toEqual([
      { from: 'packages/core', to: 'auth', count: 1 },
      { from: 'web', to: 'auth', count: 1 },
    ]);
  });
});

describe('relationshipsFrom', () => {
  it('stays unknown without TS/JS files and describes static imports otherwise', () => {
    expect(relationshipsFrom(derive([]))).toBe('unknown');
    const found = relationshipsFrom(derive([file('web/a.ts', '../api/x', 'react'), file('api/x.ts')], { skipped: 2 }));
    expect(found).toEqual({ kind: 'static-imports', edges: 1, imports: 1, unresolved: 1, truncated: false, skipped: 2 });
  });

  it('counts drawn lines (one per pair of areas), not directions', () => {
    const both = relationshipsFrom(derive([file('web/a.ts', '../api/x'), file('api/x.ts', '../web/a')]));
    expect(both).toMatchObject({ kind: 'static-imports', edges: 1, imports: 2 });
  });

  it('marks the relationships stale only when asked to', () => {
    const result = derive([file('web/a.ts', '../api/x'), file('api/x.ts')]);
    expect(relationshipsFrom(result)).not.toHaveProperty('stale');
    expect(relationshipsFrom(result, { stale: true })).toMatchObject({ kind: 'static-imports', stale: true });
    expect(relationshipsFrom(derive([]), { stale: true })).toBe('unknown');
  });

  it('still reports static imports (with zero edges) when TS/JS files exist but none cross groups', () => {
    expect(relationshipsFrom(derive([file('web/a.ts', './b'), file('web/b.ts')]))).toMatchObject({ kind: 'static-imports', edges: 0, imports: 0 });
  });
});

describe('deriveImportEdges: TypeScript source-extension substitution (Amendment 1)', () => {
  const one = (specifier: string, ...targets: string[]) => derive([file('web/a.ts', specifier), ...targets.map((t) => file(t))]);
  const resolved = (result: ReturnType<typeof one>) => result.edges.length === 1 && result.unresolved === 0;

  it('resolves .js to .ts and .tsx, .jsx to .tsx, .mjs to .mts and .cjs to .cts', () => {
    expect(resolved(one('../api/x.js', 'api/x.ts'))).toBe(true);
    expect(resolved(one('../api/x.js', 'api/x.tsx'))).toBe(true);
    expect(resolved(one('../api/x.jsx', 'api/x.tsx'))).toBe(true);
    expect(resolved(one('../api/x.mjs', 'api/x.mts'))).toBe(true);
    expect(resolved(one('../api/x.cjs', 'api/x.cts'))).toBe(true);
  });

  it('does not map to a different family: .jsx does not become .ts, .mjs does not become .ts', () => {
    expect(one('../api/x.jsx', 'api/x.ts').unresolved).toBe(1);
    expect(one('../api/x.mjs', 'api/x.ts').unresolved).toBe(1);
    expect(one('../api/x.cjs', 'api/x.mts').unresolved).toBe(1);
  });

  it('keeps the exact file when it exists (a real .js file wins over the substitution)', () => {
    const result = derive([file('web/a.ts', '../api/x.js'), file('api/x.js'), file('db/x.ts')]);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
  });

  it('substitutes before probing extensions and index files', () => {
    // `api/x.js` -> `api/x.ts` is tried before the probe `api/x.js.ts`; the probe's file belongs to another group.
    const groupOf = (path: string): string | null => (path === 'api/x.js.ts' ? 'db' : byFolder(path));
    const result = deriveImportEdges(scan([file('web/a.ts', '../api/x.js'), file('api/x.ts'), file('api/x.js.ts')]), groupOf);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
  });

  it('does not invent a target for a .js import with no counterpart', () => {
    expect(one('../api/x.js', 'api/y.ts').unresolved).toBe(1);
  });
});

describe('deriveImportEdges: path and specifier hygiene (Amendment 1)', () => {
  it('normalises backslashes in paths from the core', () => {
    const result = derive([file('web\\a.ts', '../api/x'), file('api\\x.ts')]);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
    expect(result.unresolved).toBe(0);
  });

  it('hands the group lookup normalised, project-relative POSIX paths', () => {
    const seen: string[] = [];
    deriveImportEdges(scan([file('web\\a.ts', '../api/x'), file('api\\x.ts')]), (path) => (seen.push(path), byFolder(path)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => !p.includes('\\'))).toBe(true);
  });

  it('strips ?query and #hash from specifiers before resolving', () => {
    const result = derive([file('web/a.ts', '../api/x?raw', '../api/x#frag', '../api/x.js?v=2#top'), file('api/x.ts')]);
    expect(result.edges).toEqual([{ from: 'web', to: 'api', count: 3 }]);
    expect(result.unresolved).toBe(0);
  });

  it('resolves . and .. to the directory index', () => {
    const within = derive([file('web/pages/a.ts', '..', '.'), file('web/index.ts'), file('web/pages/index.ts')]);
    expect(within.edges).toEqual([]);
    expect(within.unresolved).toBe(0);
    const across = derive([file('web/a.ts', '../api', '../api/.'), file('api/index.ts')]);
    expect(across.edges).toEqual([{ from: 'web', to: 'api', count: 2 }]);
  });

  it('probes only <dir>/index.* for a specifier that ends in /, /. , /.. or is . or .. (never <dir>.ts)', () => {
    // `api.ts` (a file) and `api/index.ts` (the directory's index) belong to different groups.
    const groupOf = (path: string): string | null => (path === 'api.ts' ? 'db' : byFolder(path));
    const run = (specifier: string, files: string[]) => deriveImportEdges(scan([file('web/a.ts', specifier), ...files.map((f) => file(f))]), groupOf);
    for (const specifier of ['../api/', '../api/.', '../api/./', '../api/sub/..']) {
      expect(run(specifier, ['api.ts', 'api/index.ts']).edges, specifier).toEqual([{ from: 'web', to: 'api', count: 1 }]);
      const withoutIndex = run(specifier, ['api.ts']);
      expect(withoutIndex.edges, specifier).toEqual([]);
      expect(withoutIndex.unresolved, specifier).toBe(1);
    }
    // `..` from web/pages names the folder `web`: only `web/index.*` counts, never a root `web.ts`.
    const up = deriveImportEdges(scan([file('web/pages/a.ts', '..'), file('web.ts'), file('web/index.ts')]), (p) => (p === 'web.ts' ? 'db' : byFolder(p)));
    expect(up.edges).toEqual([]);
    expect(up.unresolved).toBe(0);
    const onlyFile = deriveImportEdges(scan([file('web/pages/a.ts', '..'), file('web.ts')]), (p) => (p === 'web.ts' ? 'db' : byFolder(p)));
    expect(onlyFile.unresolved).toBe(1);
    expect(onlyFile.edges).toEqual([]);
  });

  it('still resolves a plain folder import (no trailing mark) to <dir>.ts before <dir>/index.ts', () => {
    const groupOf = (path: string): string | null => (path === 'api.ts' ? 'db' : byFolder(path));
    const result = deriveImportEdges(scan([file('web/a.ts', '../api'), file('api.ts'), file('api/index.ts')]), groupOf);
    expect(result.edges).toEqual([{ from: 'web', to: 'db', count: 1 }]);
  });

  it('counts a dot-prefixed bare name that only looks like a path as unresolved', () => {
    expect(derive([file('web/a.ts', '.hidden', '..foo'), file('web/.hidden.ts')]).unresolved).toBe(2);
  });
});

describe('deriveMapImportEdges (memoised per scan and group set)', () => {
  const imports = scan([file('src/web/a.ts', '../api/x'), file('src/api/x.ts')]);
  const mapped = new Set(['web', 'api']);

  it('returns the very same result for the same scan and the same groups', () => {
    const first = deriveMapImportEdges(imports, mapped, mapped);
    expect(deriveMapImportEdges(imports, new Set(['api', 'web']), new Set(['web', 'api']))).toBe(first);
    expect(first.edges).toEqual([{ from: 'web', to: 'api', count: 1 }]);
  });

  it('recomputes for a different scan object or a different group set', () => {
    const first = deriveMapImportEdges(imports, mapped, mapped);
    expect(deriveMapImportEdges({ ...imports }, mapped, mapped)).not.toBe(first);
    const fewer = deriveMapImportEdges(imports, new Set(['web']), new Set(['web']));
    expect(fewer).not.toBe(first);
    expect(fewer.edges).toEqual([]);
  });

  it('points a path in a touched-but-merged group at Other, and ignores untouched groups', () => {
    const scanned = scan([file('dir14/f.ts', '../dir00/f'), file('dir00/f.ts'), file('jobs/j.ts', '../dir00/f')]);
    const result = deriveMapImportEdges(scanned, new Set(['dir00', 'merged-other']), new Set(['dir00', 'dir14']));
    expect(result.edges).toEqual([{ from: 'merged-other', to: 'dir00', count: 1 }]);
  });
});

describe('drawnLinks', () => {
  it('draws one line per unordered pair, in the direction with more imports (ties: the alphabetically first importer)', () => {
    expect(drawnLinks([{ from: 'web', to: 'api', count: 1 }, { from: 'api', to: 'web', count: 3 }])).toEqual([{ from: 'api', to: 'web' }]);
    expect(drawnLinks([{ from: 'web', to: 'api', count: 2 }, { from: 'api', to: 'web', count: 1 }])).toEqual([{ from: 'web', to: 'api' }]);
    expect(drawnLinks([{ from: 'api', to: 'web', count: 2 }, { from: 'web', to: 'api', count: 2 }])).toEqual([{ from: 'api', to: 'web' }]);
  });

  it('keeps single-direction edges as they are and the derivation order', () => {
    const edges = [{ from: 'api', to: 'db', count: 1 }, { from: 'web', to: 'api', count: 4 }, { from: 'web', to: 'auth', count: 1 }];
    expect(drawnLinks(edges)).toEqual([{ from: 'api', to: 'db' }, { from: 'web', to: 'api' }, { from: 'web', to: 'auth' }]);
  });

  it('does not depend on the order of the edges it is given', () => {
    const a = { from: 'web', to: 'api', count: 1 };
    const b = { from: 'api', to: 'web', count: 5 };
    expect(drawnLinks([a, b])).toEqual(drawnLinks([b, a]));
  });

  it('is empty for no edges', () => {
    expect(drawnLinks([])).toEqual([]);
  });
});

describe('isProjectImports', () => {
  it('accepts the contract shape', () => {
    expect(isProjectImports(scan([file('a.ts', './b')]))).toBe(true);
    expect(isProjectImports(scan([]))).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [null, undefined, 'x', 3, {}, { files: 'x', truncated: false, skipped: 0, scannedAtMs: 1 }, { files: [{ path: 1, specifiers: [] }], truncated: false, skipped: 0, scannedAtMs: 1 }, { files: [{ path: 'a.ts', specifiers: [1] }], truncated: false, skipped: 0, scannedAtMs: 1 }, { files: [], truncated: 'no', skipped: 0, scannedAtMs: 1 }, { files: [], truncated: false, skipped: -1, scannedAtMs: 1 }, { files: [], truncated: false, skipped: 0 }]) {
      expect(isProjectImports(bad)).toBe(false);
    }
  });
});

describe('relationshipsNote', () => {
  it('says relationships are unknown when there is no static-import knowledge', () => {
    expect(relationshipsNote('unknown')).toMatch(/Relationships between groups are unknown/);
  });

  it('describes static imports as a heuristic and reports the unresolved count only when it is above zero', () => {
    const base = { edges: 2, imports: 5, unresolved: 0, truncated: false, skipped: 0 };
    expect(relationshipsNote({ kind: 'static-imports', ...base })).toContain('Relationships: static imports between areas (heuristic)');
    expect(relationshipsNote({ kind: 'static-imports', ...base })).not.toMatch(/unresolved/i);
    expect(relationshipsNote({ kind: 'static-imports', ...base, unresolved: 4 })).toMatch(/4 import specifiers? (was|were) not resolved/);
    expect(relationshipsNote({ kind: 'static-imports', ...base, unresolved: 4 })).toContain('packages, aliases, non-script or missing files');
    expect(relationshipsNote({ kind: 'static-imports', ...base, unresolved: 1 })).toMatch(/1 import specifier was not resolved/);
  });

  it('says the relationships are as of the last scan when a later rescan failed', () => {
    const base = { kind: 'static-imports' as const, edges: 1, imports: 1, unresolved: 0, truncated: false, skipped: 0 };
    expect(relationshipsNote(base)).not.toMatch(/last scan/);
    expect(relationshipsNote({ ...base, stale: true })).toMatch(/as of the last scan/);
  });

  it('flags a partial scan', () => {
    const base = { kind: 'static-imports' as const, edges: 0, imports: 0, unresolved: 0, truncated: true, skipped: 0 };
    expect(relationshipsNote(base)).toMatch(/partial/i);
    expect(relationshipsNote({ ...base, truncated: false, skipped: 2 })).toContain('2 files or folders not read (large, unreadable or online-only)');
    expect(relationshipsNote({ ...base, truncated: false, skipped: 1 })).toContain('1 file or folder not read (large, unreadable or online-only)');
    expect(relationshipsNote({ ...base, truncated: false, skipped: 2 })).not.toMatch(/large files skipped/);
    expect(relationshipsNote({ ...base, truncated: false, skipped: 0 })).not.toMatch(/not read/);
  });
});
