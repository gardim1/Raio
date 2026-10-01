import { OUTSIDE_PROJECT } from '../ingest/raioEvent';

/**
 * Disk evidence heuristics (docs/ARCHITECTURE.md, "Evidence and validation semantics").
 *
 * These are heuristics over timestamps and paths: they show that a reported edit and a disk change
 * line up, never who wrote the file. The Rust watcher coalesces changes per path, so one write is
 * expected to produce one `file.changed`; a second change near a reported edit is read as someone
 * else touching the file. Which changes are "ignored" (.gitignore, node_modules) is decided by the
 * watcher; every `file.changed` that reaches the projection counts.
 */

/** A reported edit and a disk change on the same path match when they are at most this far apart, either way. */
export const DISK_WINDOW_MS = 5000;

export interface PathMoment {
  readonly path: string;
  /** Milliseconds since epoch. */
  readonly at: number;
}

/**
 * `high`: consistent on disk with nothing else touching the path.
 * `medium`: reported by the agent, no disk change seen (watcher missing, late or the path ignored).
 * `low`: consistent on disk, but another change on the same path falls inside the window.
 */
export type EditConfidence = 'high' | 'medium' | 'low';

export interface EditAssessment extends PathMoment {
  readonly disk: 'consistent' | 'not-observed';
  readonly confidence: EditConfidence;
  /** A disk change on this path inside the window that no reported edit accounts for. */
  readonly concurrentChange: boolean;
}

interface Matching {
  /** For each edit (input order), the index of its matched change or -1. */
  readonly changeOfEdit: readonly number[];
  readonly matchedChanges: ReadonlySet<number>;
}

const byPath = (moments: readonly PathMoment[]): Map<string, number[]> => {
  const index = new Map<string, number[]>();
  moments.forEach((m, i) => {
    const list = index.get(m.path);
    if (list) list.push(i);
    else index.set(m.path, [i]);
  });
  return index;
};

/** Pairs each reported edit, earliest first, with the nearest unpaired change on its path inside the window. */
const matchEditsToChanges = (edits: readonly PathMoment[], changes: readonly PathMoment[], windowMs: number): Matching => {
  const changesByPath = byPath(changes);
  const changeOfEdit = edits.map(() => -1);
  const matchedChanges = new Set<number>();
  const order = edits.map((_, i) => i).sort((a, b) => edits[a]!.at - edits[b]!.at || a - b);
  for (const editIndex of order) {
    const edit = edits[editIndex]!;
    let best = -1;
    let bestDistance = Infinity;
    for (const changeIndex of changesByPath.get(edit.path) ?? []) {
      if (matchedChanges.has(changeIndex)) continue;
      const distance = Math.abs(changes[changeIndex]!.at - edit.at);
      if (distance <= windowMs && distance < bestDistance) {
        best = changeIndex;
        bestDistance = distance;
      }
    }
    if (best >= 0) {
      changeOfEdit[editIndex] = best;
      matchedChanges.add(best);
    }
  }
  return { changeOfEdit, matchedChanges };
};

/** Reported vs consistent-on-disk for each edit, with lowered confidence when an unaccounted change is nearby. */
export const assessReportedEdits = (edits: readonly PathMoment[], changes: readonly PathMoment[], windowMs: number = DISK_WINDOW_MS): EditAssessment[] => {
  const { changeOfEdit, matchedChanges } = matchEditsToChanges(edits, changes, windowMs);
  const changesByPath = byPath(changes);
  return edits.map((edit, i) => {
    const concurrentChange = (changesByPath.get(edit.path) ?? []).some((c) => !matchedChanges.has(c) && Math.abs(changes[c]!.at - edit.at) <= windowMs);
    if (changeOfEdit[i] === -1) return { ...edit, disk: 'not-observed', confidence: 'medium', concurrentChange };
    return { ...edit, disk: 'consistent', confidence: concurrentChange ? 'low' : 'high', concurrentChange };
  });
};

/** Disk changes no reported edit accounts for: "changed in project, author unknown". Never counted as the agent's writes. */
export const findUnassignedChanges = (changes: readonly PathMoment[], edits: readonly PathMoment[], windowMs: number = DISK_WINDOW_MS): PathMoment[] => {
  const { matchedChanges } = matchEditsToChanges(edits, changes, windowMs);
  return changes.filter((_, i) => !matchedChanges.has(i));
};

/**
 * Time of the first project change after `resultAt`, or undefined. A result recorded before it is stale.
 * Counts disk changes by anyone and reported edits made after the result (a missing watcher must not
 * keep a result green). A late echo of an edit reported before the result does not count.
 */
export const firstChangeAfter = (resultAt: number, changes: readonly PathMoment[], edits: readonly PathMoment[], windowMs: number = DISK_WINDOW_MS): number | undefined => {
  const { changeOfEdit } = matchEditsToChanges(edits, changes, windowMs);
  const echoes = new Set<number>();
  changeOfEdit.forEach((changeIndex, editIndex) => {
    if (changeIndex >= 0 && edits[editIndex]!.at <= resultAt) echoes.add(changeIndex);
  });
  const candidates: number[] = [];
  changes.forEach((change, i) => {
    if (change.path !== OUTSIDE_PROJECT && change.at > resultAt && !echoes.has(i)) candidates.push(change.at);
  });
  for (const edit of edits) if (edit.path !== OUTSIDE_PROJECT && edit.at > resultAt) candidates.push(edit.at);
  return candidates.length === 0 ? undefined : candidates.reduce((a, b) => Math.min(a, b));
};
