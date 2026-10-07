import { describe, expect, it } from 'vitest';

// Node-only packaging module, kept outside the renderer and its TypeScript inputs.
const scriptPath = '../../scripts/pack-portable.mjs';
const { staleBinaries, blockingDirtyFiles, portableReadme } = await import(scriptPath);

describe('portable package validation', () => {
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
    const text = portableReadme({ sha: '0123456789abcdef', buildTime: '2026-10-07T10:00:00.000Z', hashes: { 'raio.exe': 'a'.repeat(64), 'raio-hook.exe': 'b'.repeat(64) }, dirty: false });
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
    const text = portableReadme({ sha: 'abcdef1', buildTime: '2026-10-07T10:00:00.000Z', hashes: { 'raio.exe': 'a', 'raio-hook.exe': 'b' }, dirty: true });
    expect(text).toContain('--allow-dirty');
    expect(text).toContain('uncommitted tracked changes');
  });
});
