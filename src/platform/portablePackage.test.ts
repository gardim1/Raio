import { describe, expect, it } from 'vitest';
// Runtime imports keep these Node-only tests outside the renderer's type/dependency inputs.
const nodeTestModules = ['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:buffer', 'node:process'];
const [{ createHash }, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync }, { tmpdir }, { basename, join, resolve, sep }, { Buffer }, { execPath }] = await Promise.all(nodeTestModules.map(name => import(name)));

// Node-only packaging module, kept outside the renderer and its TypeScript inputs.
const scriptPath = '../../scripts/pack-portable.mjs';
const { staleBinaries, blockingDirtyFiles, portableReadme, packageNames, sha256Manifest, parsePackArgs, writePackageNotices, writeReleaseAssets, createReleaseLayout } = await import(scriptPath);

const withPackageFixture = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'raio-alpha-shell-pack-'));
  try { run(root); }
  finally {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('raio-alpha-shell-pack-')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
};

describe('release assets', () => {
  it('accepts wrapper metadata paths with spaces and rejects ambiguous arguments', () => {
    expect(parsePackArgs([])).toEqual({ allowDirty: false });
    expect(parsePackArgs(['--cargo-metadata', 'build files/cargo metadata.json', '--allow-dirty']))
      .toEqual({ allowDirty: true, cargoMetadata: 'build files/cargo metadata.json' });
    for (const args of [['--cargo-metadata'], ['--cargo-metadata', ''], ['--cargo-metadata', '--allow-dirty'], ['--unknown'], ['--cargo-metadata', 'a.json', '--cargo-metadata', 'b.json']]) {
      expect(() => parsePackArgs(args)).toThrow('Usage:');
    }
  });

  it('copies LICENSE, calls the generator with optional metadata, and propagates failure', () => withPackageFixture(root => {
    const folder = join(root, 'portable');
    mkdirSync(folder);
    const license = Buffer.from('MIT license fixture\r\n');
    writeFileSync(join(root, 'LICENSE'), license);
    const metadata = join(root, 'build files', 'cargo metadata.json');
    const calls: unknown[][] = [];
    const run = (...args: unknown[]) => {
      calls.push(args);
      writeFileSync(join(folder, 'THIRD-PARTY-NOTICES.txt'), 'generated notices fixture');
    };
    writePackageNotices({ root, folder, cargoMetadata: metadata }, run);
    expect(readFileSync(join(folder, 'LICENSE'))).toEqual(license);
    expect(readFileSync(join(folder, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe('generated notices fixture');
    expect(calls[0]).toEqual([execPath, [join(root, 'scripts', 'third-party-notices.mjs'), join(folder, 'THIRD-PARTY-NOTICES.txt'), '--cargo-metadata', metadata], { stdio: 'inherit' }]);
    writePackageNotices({ root, folder }, run);
    expect(calls[1]).toEqual([execPath, [join(root, 'scripts', 'third-party-notices.mjs'), join(folder, 'THIRD-PARTY-NOTICES.txt')], { stdio: 'inherit' }]);
    expect(() => writePackageNotices({ root, folder, cargoMetadata: metadata }, () => { throw new Error('generator failed'); })).toThrow('generator failed');
  }));

  it('ships a byte-identical installer and hashes the actual zip and script bytes', () => withPackageFixture(root => {
    const { release, zipName, manifestName } = createReleaseLayout({ releaseRoot: join(root, 'release-local'), version: '0.1.0-alpha.2' });
    mkdirSync(join(root, 'scripts'));
    const installer = Buffer.from('\uFEFF# caf\u00E9\r\nWrite-Output "Raio"\r\n', 'utf8');
    const zip = Buffer.from([0x50, 0x4b, 0, 255, 128]);
    writeFileSync(join(root, 'scripts', 'install-raio.ps1'), installer);
    writeFileSync(join(release, zipName), zip);
    writeReleaseAssets({ root, release, zipName, manifestName });
    expect(readFileSync(join(release, 'install-raio.ps1'))).toEqual(installer);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(readFileSync(join(release, manifestName), 'utf8')).toBe(`${hash(zip)}  ${zipName}\n${hash(installer)}  install-raio.ps1\n`);
    expect(() => writeReleaseAssets({ root, release, zipName, manifestName })).toThrow();
  }));
});
describe('portable package validation', () => {
  it('names the directory, zip and checksum manifest from the release version', () => {
    expect(packageNames('0.1.0')).toEqual({ name: 'raio-v0.1.0-windows-x64', zipName: 'raio-v0.1.0-windows-x64.zip', manifestName: 'SHA256SUMS-v0.1.0.txt' });
    expect(packageNames('1.2.3-alpha.4')).toEqual({ name: 'raio-v1.2.3-alpha.4-windows-x64', zipName: 'raio-v1.2.3-alpha.4-windows-x64.zip', manifestName: 'SHA256SUMS-v1.2.3-alpha.4.txt' });
    for (const version of ['', '1.2', 'v1.2.3', '../1.2.3', '1.2.3\n', '01.2.3']) {
      expect(() => packageNames(version)).toThrow('version');
    }
  });

  it('writes checksum lines that identify the archive and optional loose executables', () => {
    expect(sha256Manifest([
      { name: 'raio-v0.1.0-windows-x64.zip', sha256: 'a'.repeat(64) },
      { name: 'raio-v0.1.0-windows-x64/raio.exe', sha256: 'b'.repeat(64) },
    ])).toBe(`${'a'.repeat(64)}  raio-v0.1.0-windows-x64.zip\n${'b'.repeat(64)}  raio-v0.1.0-windows-x64/raio.exe\n`);
  });

  it('requires both executables to be strictly newer than the newest source', () => {
    expect(staleBinaries([{ name: 'raio.exe', mtimeMs: 101 }, { name: 'raio-hook.exe', mtimeMs: 102 }], 100)).toEqual([]);
    expect(staleBinaries([{ name: 'raio.exe', mtimeMs: 100 }, { name: 'raio-hook.exe', mtimeMs: 99 }], 100)).toEqual(['raio.exe', 'raio-hook.exe']);
  });

  it('rejects a missing executable even if the other is fresh', () => {
    expect(staleBinaries([{ name: 'raio.exe', mtimeMs: null }, { name: 'raio-hook.exe', mtimeMs: 200 }], 100)).toEqual(['raio.exe']);
    expect(staleBinaries([{ name: 'raio.exe', mtimeMs: 200 }, { name: 'raio-hook.exe', mtimeMs: null }], 100)).toEqual(['raio-hook.exe']);
  });

  it('allows docs and Markdown changes while retaining code/config/deletion paths', () => {
    expect(blockingDirtyFiles(['docs/guide.txt', 'README.md', 'nested/NOTES.MD', 'src/main.tsx', 'package.json', '.gitignore', 'docs-other/a.txt']))
      .toEqual(['src/main.tsx', 'package.json', '.gitignore', 'docs-other/a.txt']);
    expect(blockingDirtyFiles(['src/renamed-from.ts', 'src/renamed-to.ts', 'docs/deleted.txt'])).toEqual(['src/renamed-from.ts', 'src/renamed-to.ts']);
  });

  it('allows Windows separators for documentation paths', () => {
    expect(blockingDirtyFiles(['docs\\guide.txt', 'src\\main.ts'])).toEqual(['src\\main.ts']);
  });

  it('puts the supplied provenance and both executable hashes in the portable README', () => {
    const text = portableReadme({ version: '0.1.0-alpha.2', sha: '0123456789abcdef', buildTime: '2026-10-07T10:00:00.000Z', hashes: { 'raio.exe': 'a'.repeat(64), 'raio-hook.exe': 'b'.repeat(64) }, dirty: false });
    expect(text).toContain('Version: 0.1.0-alpha.2');
    expect(text).toContain('LICENSE');
    expect(text).toContain('THIRD-PARTY-NOTICES.txt');
    expect(text).toContain('Get-FileHash -Algorithm SHA256 install-raio.ps1');
    expect(text).toContain('SHA256SUMS-v0.1.0-alpha.2.txt');
    expect(text).toContain('release-local/v0.1.0-alpha.2/');
    expect(text).toContain("-Version '0.1.0-alpha.2' -Source .");
    expect(text).toContain('Commit: 0123456789abcdef');
    expect(text).toContain('2026-10-07T10:00:00.000Z');
    expect(text).toContain(`raio.exe: ${'a'.repeat(64)}`);
    expect(text).toContain(`raio-hook.exe: ${'b'.repeat(64)}`);
    expect(text).toContain('%APPDATA%\\io.github.gardim1.raio');
    expect(text).toContain('SmartScreen');
    expect(text).toContain('Disconnect');
    expect(text).toContain('Reconnect');
    expect(text).toContain('tray');
    expect(text).toContain('delete');
  });

  it('labels an allowed dirty tree rather than implying the commit fully identifies the build', () => {
    const text = portableReadme({ version: '0.1.0', sha: 'abcdef1', buildTime: '2026-10-07T10:00:00.000Z', hashes: { 'raio.exe': 'a', 'raio-hook.exe': 'b' }, dirty: true });
    expect(text).toContain('--allow-dirty');
    expect(text).toContain('uncommitted tracked changes');
  });
});

it('keeps the first version installer and checksum valid after packaging a changed installer for the next version', () => withPackageFixture(root => {
  const releaseRoot = join(root, 'release-local');
  mkdirSync(join(root, 'scripts'));
  const writeVersion = (version: string, installer: string) => {
    const { release, zipName, manifestName } = createReleaseLayout({ releaseRoot, version });
    const zip = Buffer.from('zip fixture ' + version);
    writeFileSync(join(root, 'scripts', 'install-raio.ps1'), installer);
    writeFileSync(join(release, zipName), zip);
    writeReleaseAssets({ root, release, zipName, manifestName });
    return { release, zipName, manifestName, installer, zip };
  };
  const first = writeVersion('0.1.0-alpha.1', '# first installer\r\n');
  const firstManifest = readFileSync(join(first.release, first.manifestName), 'utf8');
  const second = writeVersion('0.1.0-alpha.2', '# changed installer\r\n');
  expect(readdirSync(releaseRoot).sort()).toEqual(['v0.1.0-alpha.1', 'v0.1.0-alpha.2']);
  expect(readFileSync(join(first.release, 'install-raio.ps1'), 'utf8')).toBe(first.installer);
  expect(readFileSync(join(first.release, first.manifestName), 'utf8')).toBe(firstManifest);
  for (const version of [first, second]) {
    expect(readFileSync(join(version.release, version.zipName))).toEqual(version.zip);
    const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
    expect(readFileSync(join(version.release, version.manifestName), 'utf8')).toBe(
      `${hash(version.zip)}  ${version.zipName}\n${hash(version.installer)}  install-raio.ps1\n`,
    );
  }
}));

it('allocates every asset under its version and refuses complete or partial existing version folders', () => withPackageFixture(root => {
  const releaseRoot = join(root, 'Release files');
  const layout = createReleaseLayout({ releaseRoot, version: '0.1.0-alpha.3' });
  expect(layout.release).toBe(join(releaseRoot, 'v0.1.0-alpha.3'));
  expect(layout.folder).toBe(join(layout.release, 'raio-v0.1.0-alpha.3-windows-x64'));
  expect(layout.zip).toBe(join(layout.release, 'raio-v0.1.0-alpha.3-windows-x64.zip'));
  expect(layout.manifest).toBe(join(layout.release, 'SHA256SUMS-v0.1.0-alpha.3.txt'));
  expect(layout.installer).toBe(join(layout.release, 'install-raio.ps1'));
  writeFileSync(join(layout.folder, 'raio-hook.exe'), 'do not replace');
  expect(() => createReleaseLayout({ releaseRoot, version: '0.1.0-alpha.3' })).toThrow('already exists');
  expect(readFileSync(join(layout.folder, 'raio-hook.exe'), 'utf8')).toBe('do not replace');
  mkdirSync(join(releaseRoot, 'v0.1.0-alpha.4'));
  expect(() => createReleaseLayout({ releaseRoot, version: '0.1.0-alpha.4' })).toThrow('already exists');
  expect(() => createReleaseLayout({ releaseRoot, version: '../other' })).toThrow('version');
}));

it('refuses replacing an installer even when the manifest has not been completed', () => withPackageFixture(root => {
  const { release, zipName, manifestName, installer } = createReleaseLayout({ releaseRoot: join(root, 'release-local'), version: '0.1.0' });
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'install-raio.ps1'), '# new installer');
  writeFileSync(installer, '# existing installer');
  writeFileSync(join(release, zipName), 'zip fixture');
  expect(() => writeReleaseAssets({ root, release, zipName, manifestName })).toThrow('already exists');
  expect(readFileSync(installer, 'utf8')).toBe('# existing installer');
}));
