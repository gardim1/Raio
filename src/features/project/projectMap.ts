import type { ArchitectureGraph } from '../architecture/model/types';
import type { CoreHealth, DataProvenance } from '../../platform/desktopBridge';
import { OTHER_GROUP } from './classifyPath';
import { deriveMapImportEdges, drawnLinks, relationshipsFrom, relationshipsNote, type ProjectImports } from './importEdges';
import { groupInventory, inventoryNotes } from './inventoryGroups';
import { layoutGroups } from './layoutGroups';
import type { ProjectInventory } from './projectInventory';
import type { ProjectRef } from './projectSession';

/** A connected project's map without an agent, session, activity or replay. */
export interface ProjectMapSnapshot {
  readonly project: ProjectRef;
  readonly provenance: DataProvenance;
  readonly graph: ArchitectureGraph;
  readonly listing: 'pending' | 'ready' | 'unavailable';
  /** Absent on older adapters; an unknown count must never be treated as an empty folder. */
  readonly listingDetails?: {
    readonly fileCount: number | null;
    readonly truncated: boolean;
    readonly skipped: number;
    readonly stale: boolean;
    readonly unavailableReason: string | null;
  };
  readonly note: string;
  readonly technologies: readonly string[];
  /** null: core status/refresh unavailable; absent only for older adapters and fixtures. */
  readonly core?: CoreHealth | null;
}

export const projectMap = (
  project: ProjectRef,
  inventory: ProjectInventory | null,
  imports: ProjectImports | null,
  options: { pending?: boolean; inventoryStale?: boolean; importsStale?: boolean; provenance?: DataProvenance; core?: CoreHealth | null; unavailableReason?: string } = {},
): ProjectMapSnapshot => {
  const map = inventory ? groupInventory(inventory) : null;
  const groups = map?.groups ?? [];
  const derived = map && imports ? deriveMapImportEdges(imports, new Set(groups.map((g) => g.groupId)), new Set(), map.classify) : null;
  const relationships = derived ? relationshipsFrom(derived, { stale: options.importsStale }) : 'unknown';
  return {
    project: { id: project.id, name: project.name },
    provenance: options.provenance ?? 'live',
    ...(options.core !== undefined ? { core: options.core } : {}),
    graph: layoutGroups(groups, derived ? drawnLinks(derived.edges) : [], map && !groups.some((g) => g.groupId === OTHER_GROUP.groupId) ? [OTHER_GROUP] : []),
    listing: inventory ? 'ready' : options.pending ? 'pending' : 'unavailable',
    listingDetails: { fileCount: inventory?.files.length ?? null, truncated: inventory?.truncated ?? false,
      skipped: inventory?.skipped ?? 0, stale: options.inventoryStale ?? false,
      unavailableReason: !inventory && !options.pending ? options.unavailableReason ?? null : null },
    note: inventory
      ? [relationshipsNote(relationships, 'inventory'), ...inventoryNotes(inventory, { stale: options.inventoryStale })].join(' ')
      : relationshipsNote('unknown', 'inventory'),
    technologies: map?.technologies ?? [],
  };
};
