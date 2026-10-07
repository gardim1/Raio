import type { ArchitectureGraph } from '../architecture/model/types';
import type { DataProvenance } from '../../platform/desktopBridge';
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
  readonly note: string;
  readonly technologies: readonly string[];
}

export const projectMap = (
  project: ProjectRef,
  inventory: ProjectInventory | null,
  imports: ProjectImports | null,
  options: { pending?: boolean; inventoryStale?: boolean; importsStale?: boolean; provenance?: DataProvenance } = {},
): ProjectMapSnapshot => {
  const map = inventory ? groupInventory(inventory) : null;
  const groups = map?.groups ?? [];
  const derived = map && imports ? deriveMapImportEdges(imports, new Set(groups.map((g) => g.groupId)), new Set(), map.classify) : null;
  const relationships = derived ? relationshipsFrom(derived, { stale: options.importsStale }) : 'unknown';
  return {
    project: { id: project.id, name: project.name },
    provenance: options.provenance ?? 'live',
    graph: layoutGroups(groups, derived ? drawnLinks(derived.edges) : [], map && !groups.some((g) => g.groupId === OTHER_GROUP.groupId) ? [OTHER_GROUP] : []),
    listing: inventory ? 'ready' : options.pending ? 'pending' : 'unavailable',
    note: inventory
      ? [relationshipsNote(relationships, 'inventory'), ...inventoryNotes(inventory, { stale: options.inventoryStale })].join(' ')
      : options.pending ? 'Mapping project. No agent session has been observed.' : 'Project listing unavailable. No agent session has been observed.',
    technologies: map?.technologies ?? [],
  };
};
