import { expect, it } from 'vitest';
import { projectMap } from './projectMap';

const project = { id: 'fixture', name: 'Uma pasta com espaços e acentuação ' + 'longa '.repeat(12) };
const inventory = { files: ['readme.md'], manifests: [], truncated: true, skipped: 2, scannedAtMs: 1 };
it('retains listing facts separately from area recognition and preserves the literal folder name', () => {
  const map = projectMap(project, inventory, null, { inventoryStale: true });
  expect(map.project.name).toBe(project.name);
  expect(map.graph.nodes).toHaveLength(0);
  expect(map).toHaveProperty('listingDetails', { fileCount: 1, truncated: true, skipped: 2, stale: true, unavailableReason: null });
});
it('distinguishes an unlisted folder from a successfully listed empty folder', () => {
  expect(projectMap(project, null, null, { pending: true })).toHaveProperty('listingDetails.fileCount', null);
  expect(projectMap(project, { ...inventory, files: [], truncated: false, skipped: 0 }, null)).toHaveProperty('listingDetails.fileCount', 0);
});
