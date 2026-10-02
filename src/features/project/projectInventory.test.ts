import { describe, expect, it } from 'vitest';
import { isProjectInventory } from './projectInventory';

const valid = () => ({
  files: ['src/index.ts', 'package.json'],
  truncated: false,
  skipped: 0,
  scannedAtMs: 1_000,
  manifests: [{ path: 'package.json', kind: 'npm', facts: { dependencies: ['react'], scripts: ['build'] } }],
});

describe('isProjectInventory', () => {
  it('accepts the shape the core returns, including empty facts and no manifests', () => {
    expect(isProjectInventory(valid())).toBe(true);
    expect(isProjectInventory({ ...valid(), manifests: [] })).toBe(true);
    expect(isProjectInventory({ ...valid(), manifests: [{ path: 'compose.yml', kind: 'compose', facts: {} }] })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'inventory'],
    ['no files', { ...valid(), files: undefined }],
    ['a non-string path', { ...valid(), files: ['a.ts', 3] }],
    ['no truncated flag', { ...valid(), truncated: undefined }],
    ['a negative skipped count', { ...valid(), skipped: -1 }],
    ['no manifests', { ...valid(), manifests: undefined }],
    ['a manifest of unknown kind', { ...valid(), manifests: [{ path: 'x', kind: 'gradle', facts: {} }] }],
    ['facts that are not lists of strings', { ...valid(), manifests: [{ path: 'package.json', kind: 'npm', facts: { dependencies: 'react' } }] }],
    ['facts with a non-string entry', { ...valid(), manifests: [{ path: 'package.json', kind: 'npm', facts: { dependencies: [1] } }] }],
  ])('rejects %s', (_name, value) => {
    expect(isProjectInventory(value)).toBe(false);
  });

  it('rejects absolute paths, which would leak a personal location', () => {
    expect(isProjectInventory({ ...valid(), files: ['C:/Users/someone/app/index.ts'] })).toBe(false);
    expect(isProjectInventory({ ...valid(), files: ['/home/someone/app/index.ts'] })).toBe(false);
    expect(isProjectInventory({ ...valid(), manifests: [{ path: '/etc/package.json', kind: 'npm', facts: {} }] })).toBe(false);
  });

  it('rejects paths that climb out of the project', () => {
    expect(isProjectInventory({ ...valid(), files: ['../secrets/key.pem'] })).toBe(false);
    expect(isProjectInventory({ ...valid(), files: ['src/../../outside.ts'] })).toBe(false);
    expect(isProjectInventory({ ...valid(), files: ['src\\..\\x.ts'] })).toBe(false);
    expect(isProjectInventory({ ...valid(), manifests: [{ path: '../package.json', kind: 'npm', facts: {} }] })).toBe(false);
    expect(isProjectInventory({ ...valid(), files: ['src/a..b.ts', 'src/..hidden/x.ts', 'src/...'] })).toBe(true);
  });

  it('rejects an implausibly large file list instead of holding it', () => {
    expect(isProjectInventory({ ...valid(), files: Array.from({ length: 50_001 }, (_, i) => `f${i}.ts`) })).toBe(false);
  });
});
