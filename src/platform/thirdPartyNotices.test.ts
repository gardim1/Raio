import { describe, expect, it } from 'vitest';
// Runtime imports keep these Node-only tests outside the renderer's type/dependency inputs.
const nodeTestModules = ['node:fs', 'node:os', 'node:path', '../../scripts/third-party-notices.mjs'];
const [{ mkdtempSync, writeFileSync }, { tmpdir }, { join }, { fallbackNotice, licenseFiles, shippedCrates, shippedNpm }] = await Promise.all(nodeTestModules.map(name => import(name)));

describe('third-party notices', () => {
  it('keeps only crates reachable through normal dependencies', () => {
    const metadata = {
      resolve: {
        root: 'raio',
        nodes: [
          { id: 'raio', deps: [{ pkg: 'a', dep_kinds: [{ kind: null }] }, { pkg: 'b', dep_kinds: [{ kind: 'build' }] }, { pkg: 'c', dep_kinds: [{ kind: 'dev' }] }] },
          { id: 'a', deps: [{ pkg: 'd', dep_kinds: [{ kind: null }] }] },
        ],
      },
      packages: ['raio', 'a', 'b', 'c', 'd'].map((id) => ({ id, name: id, version: '1.0.0' })),
    };
    expect(shippedCrates(metadata).map((p: { name: string }) => p.name)).toEqual(['a', 'd']);
  });

  it('keeps only runtime npm dependencies', () => {
    const lock = { packages: { '': { dependencies: { r: '1' } }, 'node_modules/r': { version: '1.0.0', license: 'MIT', dependencies: { s: '1' } }, 'node_modules/s': { version: '2.0.0', license: 'ISC' }, 'node_modules/dev': { version: '1.0.0', dev: true } } };
    expect(shippedNpm(lock).map((p: { name: string }) => p.name)).toEqual(['r', 's']);
  });

  it('finds a kept notice by name or crate family, and none for an unknown component', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raio-notices-'));
    writeFileSync(join(dir, 'webview2-com.txt'), 'MIT');
    expect(fallbackNotice('webview2-com-sys', dir)).toBe(join(dir, 'webview2-com.txt'));
    expect(fallbackNotice('webview2-com', dir)).toBe(join(dir, 'webview2-com.txt'));
    expect(fallbackNotice('other', dir)).toBeNull();
    expect(licenseFiles(dir)).toEqual([]);
  });

  it('keeps a notice in the repository for every crate known to ship without a license file', () => {
    for (const name of ['alloc-stdlib', 'defmt-parser', 'selectors', 'webview2-com', 'webview2-com-macros', 'webview2-com-sys']) {
      expect(fallbackNotice(name), name).not.toBeNull();
    }
  });
});
