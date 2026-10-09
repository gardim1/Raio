import type { CoreHealth, IntegrationStatus, ProjectHooksState } from '../../platform/desktopBridge';
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

const clockAt = (at: number | null, timeZone?: string): string | null => at == null || !Number.isFinite(at) ? null : new Intl.DateTimeFormat('en-GB', {
  hour:'2-digit', minute:'2-digit', hourCycle:'h23', ...(timeZone ? { timeZone } : {}),
}).format(at);

const inertMarkerIsCurrent = (integration: IntegrationStatus | undefined): boolean => integration?.inertMarkerAt != null
  && (integration.lastHookEventAt === null || integration.lastHookEventAt <= integration.inertMarkerAt);
const isWatcherSource = (source: string): boolean => source === 'watcher' || source.startsWith('Filesystem observation');

/** One source-labelled integration line shared by the project sidebar and the Island. */
export const integrationIndicator = (integration: IntegrationStatus | undefined, presence: PresenceInput | undefined, now: number, timeZone?: string): string | null => {
  if (integration) {
    if (inertMarkerIsCurrent(integration)) return 'Integration problem: Raio was not running';
    if (integration.hooks === 'outdated') return 'Integration problem: Hooks out of date';
    if (integration.hooks === 'missing') return 'Integration problem: Hooks missing';
    if (integration.hooks === 'unknown') return 'Integration problem: Hook status unknown';
    if (!integration.hookBinary) return 'Integration problem: raio-hook.exe missing next to raio.exe';
    if (integration.heartbeatAgeMs !== null && integration.heartbeatAgeMs > 7 * 24 * 60 * 60_000) return 'Integration problem: Raio heartbeat is stale';
    if (integration.lastHookEventAt !== null && now - integration.lastHookEventAt <= 5 * 60_000) {
      const at = clockAt(integration.lastHookEventAt, timeZone);
      return `Following session ${(integration.lastHookSessionId ?? 'unknown').slice(0, 9)} · last event ${at ?? 'time unavailable'}`;
    }
    const watcherAt = Math.max(integration.lastWatcherChangeAt ?? -Infinity,
      presence?.facts.reduce((last, fact) => Number.isFinite(fact.at) && fact.at <= now && fact.kind === 'change' && isWatcherSource(fact.source) ? Math.max(last, fact.at) : last, -Infinity) ?? -Infinity);
    if (Number.isFinite(watcherAt) && watcherAt > (integration.lastHookEventAt ?? -Infinity)) {
      const at = clockAt(watcherAt, timeZone);
      return `File changed — source unknown${at ? ` · ${at}` : ''}`;
    }
    if (integration.lastHookEventAt !== null) {
      const at = clockAt(integration.lastHookEventAt, timeZone);
      return `No recent activity · last event ${at ?? 'time unavailable'}`;
    }
  }
  const latest = presence?.facts.reduce((last, fact) => Number.isFinite(fact.at) && fact.at <= now && (!last || fact.at > last.at) ? fact : last, null as (typeof presence.facts)[number] | null);
  if (latest?.kind === 'change' && isWatcherSource(latest.source)) {
    const at = clockAt(latest.at, timeZone);
    return `File changed — source unknown${at ? ` · ${at}` : ''}`;
  }
  if (integration?.hooks === 'current' && integration.hookBinary && integration.lastHookEventAt === null
    && integration.heartbeatAgeMs !== null && integration.heartbeatAgeMs <= 7 * 24 * 60 * 60_000) return 'Integration configured · waiting for the first Claude event';
  return null;
};

/** Repository facts and reception health, without inventing a session from an empty map. */
export const deriveSidebarState = ({ snapshot, connected = true, hooks = 'unknown', presence, integration, session, timeZone, now = Date.now() }: {
  readonly snapshot: ProjectMapSnapshot;
  readonly connected?: boolean;
  readonly hooks?: ProjectHooksState;
  readonly presence?: PresenceInput;
  readonly integration?: IntegrationStatus;
  readonly session?: { readonly summary: string };
  readonly timeZone?: string;
  readonly now?: number;
}): SidebarState => {
  const { details, warnings } = splitMapNotes(snapshot.note);
  const listing = snapshot.listingDetails;
  const problem = receptionProblem(snapshot.core, snapshot.provenance === 'fixture');
  warnings.push(...coreWarnings(snapshot.core));
  if (problem) warnings.push(problem);
  if (listing?.stale) warnings.push('The latest relisting failed, so these areas are as of the last listing.');
  if (listing?.truncated) warnings.push('The project listing was partial, so some areas may be missing.');
  const noteHasSkippedReason = warnings.some(note => /^(?:\d+ (?:file or folder|files or folders|items?) not listed)\b/i.test(note));
  if (listing && listing.skipped > 0 && !noteHasSkippedReason) warnings.push(`${listing.skipped} ${listing.skipped === 1 ? 'file or folder' : 'files or folders'} not listed (large, unreadable or online-only).`);
  const integrationLine = integrationIndicator(integration, presence, now, timeZone);
  const indicator = !connected ? 'Not connected' : integrationLine ?? (problem || presence?.available === false ? 'Connection status unavailable'
    : hooks === 'outdated' ? 'Hooks out of date' : presence?.facts.length ? 'No recent activity' : 'Connected · no activity yet');
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
  return { ...base, heading: integrationLine ? 'Project overview' : problem || hooks === 'outdated' || presence?.available === false ? 'Activity cannot be confirmed' : 'Waiting for activity',
    message: inertMarkerIsCurrent(integration)
      ? 'Events were skipped before Raio restarted.'
      : integration?.heartbeatAgeMs !== null && integration?.heartbeatAgeMs !== undefined && integration.heartbeatAgeMs > 7 * 24 * 60 * 60_000 ? 'Start Raio to resume recording Claude events.'
      : integration?.hooks === 'outdated' ? null
        : integration?.hooks === 'missing' ? null
          : integration && !integration.hookBinary ? 'Restore raio-hook.exe next to raio.exe.'
            : integrationLine ? null : problem || hooks === 'outdated' || presence?.available === false ? null : 'Start a new Claude Code session in this folder. Hooks apply to new sessions.', action: null };
};
