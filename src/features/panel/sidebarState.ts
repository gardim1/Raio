import type { CoreHealth, ProjectHooksState } from '../../platform/desktopBridge';
import { receptionProblem } from '../../platform/coreHealth';
import type { PresenceInput } from '../modes/companionPresence';
import type { ProjectMapSnapshot } from '../project/projectMap';

/** Only known explanatory sentences may be collapsed. New/unrecognised notices stay visible. */
export const splitMapNotes = (note: string) => {
  const details: string[] = [], warnings: string[] = [];
  for (const sentence of note.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const technical = /^(?:Areas are a heuristic guess|Groups are a heuristic guess|Relationships between (?:areas|groups) are unknown|Relationships unknown\.|Relationships: static imports|\d+ pairs? of areas import each other|\d+ import specifiers? (?:was|were) not resolved)/.test(sentence);
    (technical ? details : warnings).push(sentence);
  }
  return { details, warnings };
};

export const coreWarnings = (core: CoreHealth | null | undefined): string[] => {
  const warnings: string[] = [];
  if (core && (core.dropped > 0 || core.droppedAtLeast)) warnings.push(core.droppedAtLeast && core.dropped === 0
    ? 'Some events may not have been recorded; this session may be incomplete.'
    : `${core.droppedAtLeast ? 'At least ' : ''}${core.dropped} event(s) could not be recorded; this session may be incomplete.`);
  if (core?.watcherOverflow) warnings.push('The file watcher overflowed; some disk changes may be missing.');
  if (core?.historyResetFrom) warnings.push('Local history was unreadable and was moved aside; earlier sessions are not shown.');
  return warnings;
};

export interface SidebarState {
  readonly projectName: string;
  readonly indicator: string;
  readonly heading: string;
  readonly message: string | null;
  readonly action: 'connect' | 'choose-another' | null;
  readonly areaCount: string;
  readonly details: readonly string[];
  readonly warnings: readonly string[];
}

/** Repository facts and reception health, without inventing a session from an empty map. */
export const deriveSidebarState = ({ snapshot, connected = true, hooks = 'unknown', presence, session, timeZone }: {
  readonly snapshot: ProjectMapSnapshot;
  readonly connected?: boolean;
  readonly hooks?: ProjectHooksState;
  readonly presence?: PresenceInput;
  readonly session?: { readonly summary: string };
  readonly timeZone?: string;
}): SidebarState => {
  const { details, warnings } = splitMapNotes(snapshot.note);
  const listing = snapshot.listingDetails;
  const problem = receptionProblem(snapshot.core, snapshot.provenance === 'fixture');
  warnings.push(...coreWarnings(snapshot.core));
  if (problem) warnings.push(problem);
  if (listing?.stale) warnings.push('The latest relisting failed, so these areas are as of the last listing.');
  if (listing?.truncated) warnings.push('The project listing was partial, so some areas may be missing.');
  if (listing && listing.skipped > 0) warnings.push(`${listing.skipped} ${listing.skipped === 1 ? 'file or folder' : 'files or folders'} not listed (large, unreadable or online-only).`);
  const lastActivity = presence?.facts.reduce<number | null>((last, fact) => Number.isFinite(fact.at) ? Math.max(last ?? fact.at, fact.at) : last, null);
  const clock = lastActivity == null ? null : new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}),
  }).format(lastActivity);
  const indicator = !connected ? 'Not connected' : problem || presence?.available === false ? 'Connection status unavailable'
    : hooks === 'outdated' ? 'Hooks out of date' : clock ? `Connected · last activity ${clock}`
    : presence ? 'Connected · no activity yet' : hooks === 'unknown' && snapshot.provenance !== 'fixture' ? 'Connected · activity unknown' : 'Connected · no activity yet';
  const count = snapshot.graph.nodes.length;
  const base = { projectName: snapshot.project.name, indicator, areaCount: `${count} ${count === 1 ? 'area' : 'areas'}`, details, warnings: [...new Set(warnings)] };
  if (!connected) return { ...base, heading: 'No project yet', message: 'Choose a repository and review the connection.', action: 'connect' };
  if (session) return { ...base, heading: session.summary, message: null, action: null };
  if (snapshot.listing === 'pending') return { ...base, heading: 'Mapping project…', message: null, action: null };
  if (snapshot.listing === 'unavailable') return { ...base, heading: "Couldn't list this folder", message: listing?.unavailableReason ?? 'The project listing is unavailable.', action: null };
  const incomplete = listing?.stale || listing?.truncated || (listing?.skipped ?? 0) > 0;
  if (count === 0 && listing?.fileCount === 0 && !incomplete) return { ...base, heading: 'No code to map yet', message: null, action: 'choose-another' };
  if (count === 0) {
    details.push('No areas could be inferred from the listed folders and manifests. The project may contain code that this heuristic does not recognize.');
    return { ...base, heading: incomplete ? 'Map incomplete' : 'No areas recognized', message: null, action: null };
  }
  return { ...base, heading: problem || hooks === 'outdated' || presence?.available === false ? 'Activity cannot be confirmed' : 'Waiting for activity',
    message: problem || hooks === 'outdated' || presence?.available === false ? null : 'Start a new Claude Code session in this folder. Hooks apply to new sessions.', action: null };
};
