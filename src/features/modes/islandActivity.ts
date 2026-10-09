import { RISK_LABEL, type SessionLog } from '../session/model/events';
import { unknownResultText } from '../session/model/unknownResultText';
import { formatClockTime } from './sessionMeta';
import type { CompanionPresence, PresenceFact } from './companionPresence';

/** Short functional caption; time/source/reason remain in the activity line and accessible description. */
export const islandCaption = (companion: CompanionPresence, area?: string | null, agent?: string): string => {
  if (companion.state === 'unknown' || companion.state === 'disconnected') return companion.label;
  if (companion.state === 'failure') return companion.label.replace(/ · \d{2}:\d{2}$/, '');
  if (companion.activeUntil !== null && area && agent) return `${agent} · ${area}`;
  if (companion.state === 'attention') return companion.label.replace(/ · \d{2}:\d{2}$/, '');
  return companion.label === 'Connected · quiet' ? 'Waiting' : companion.label;
};

/** The final recorded fact, independent of the animation's progress or its generated task. */
export const islandActivity = (log: SessionLog | null, timeZone?: string): string => {
  const event = log?.events.at(-1);
  if (!event) return 'No activity observed';
const label = event.kind === 'file.read' ? `Read ${event.path}`
    : event.kind === 'file.write' ? `File activity · ${event.path}`
      : event.kind === 'file.attempt' ? `Edit attempted · ${event.path}`
        : event.kind === 'file.failed' ? `Edit failed · ${event.path}`
          : event.kind === 'command' ? event.status === 'did-not-start' ? `Could not start ${event.program || 'the command'} — check did not run` : 'Command failed'
      : event.kind === 'validation' && event.status === 'unknown' && event.detail === 'did-not-start' ? unknownResultText(event.detail, event.program)
        : event.kind === 'validation' ? `${event.validation === 'tests' ? 'Tests' : 'Build'} ${event.status}`
        : event.kind === 'risk' ? RISK_LABEL[event.risk]
          : event.kind === 'session.end' ? 'Turn ended' : 'Session started';
  const started = Date.parse(log!.startedAt);
  const at = Number.isFinite(started) ? formatClockTime(new Date(started + event.atMs).toISOString(), timeZone) : null;
  return at ? `${label} · ${at}` : label;
};

/** Watcher facts can arrive before an agent session; a source is evidence, not agent attribution. */
export const islandPresenceActivity = (facts: readonly PresenceFact[], now: number, timeZone?: string): string => {
  const latest = facts.reduce<PresenceFact | null>((last, fact) => fact.at <= now && (!last || fact.at > last.at) ? fact : last, null);
  if (!latest) return 'Activity details unavailable';
  const at = formatClockTime(new Date(latest.at).toISOString(), timeZone);
  return `${latest.source}${at ? ` · ${at}` : ''}`;
};

/** Use the companion's project-wide observations, including facts omitted by the replay projection. */
export const islandObservedActivity = (facts: readonly PresenceFact[], now: number, timeZone?: string): string => {
  const latest = facts.reduce<PresenceFact | null>((last, fact) => Number.isFinite(fact.at) && fact.at <= now && (!last || fact.at >= last.at) ? fact : last, null);
  if (!latest) return 'No activity observed';
  // Ordinary commands are activity; the distinct turn boundary never establishes a check result.
  const at = formatClockTime(new Date(latest.at).toISOString(), timeZone);
  if (latest.source.startsWith('Filesystem observation')) return `File changed — source unknown${at ? ` · ${at}` : ''}`;
  const label = latest.kind === 'activity' ? 'Activity observed'
    : latest.kind === 'edit-attempted' ? `Edit attempted${latest.paths?.[0] ? ` · ${latest.paths[0]}` : ''}`
    : latest.kind === 'command-not-started' ? `Could not start ${latest.program || 'the command'} — check did not run`
    : latest.kind === 'turn-end' ? 'Turn ended'
    : latest.kind === 'change' ? 'File change observed'
    : latest.kind === 'edit-failed' ? `Edit failed${latest.paths?.[0] ? ` · ${latest.paths[0]}` : ''}`
    : latest.kind === 'start' ? 'Session started'
    : latest.kind === 'end' ? 'Session ended'
    : `${latest.checkClass === 'tests' ? 'Tests' : latest.checkClass === 'build' ? 'Build' : 'Command'} ${latest.result ?? 'unknown'} (recorded)`;
  return `${label}${at ? ` · ${at}` : ''} · ${latest.source}`;
};

/** Recent observations do not prove an operation is still running. Keep their time and source explicit. */
export const islandPreviewActivity = (companion: CompanionPresence, facts: readonly PresenceFact[], now: number, timeZone?: string, replayActivity?: string): string => {
  if (companion.state === 'disconnected') return 'Choose a project to connect';
  if (companion.state === 'unknown') return 'Activity status unavailable';
  const latest = facts.reduce<PresenceFact | null>((last, fact) => Number.isFinite(fact.at) && fact.at <= now && (!last || fact.at >= last.at) ? fact : last, null);
  if (latest) {
    const at = formatClockTime(new Date(latest.at).toISOString(), timeZone);
    if (latest.source.startsWith('Filesystem observation')) return `File changed — source unknown${at ? ` · ${at}` : ''}`;
    const observed = islandObservedActivity([latest], now, timeZone);
    const label = observed.slice(0, observed.length - ` · ${latest.source}`.length).replace(/ · \d{2}:\d{2}$/, '');
    return `Last activity${at ? ` · ${at}` : ''} · ${label} · ${latest.source}`;
  }
  if (replayActivity) {
    const match = replayActivity.match(/^(.*) · (\d{2}:\d{2})$/);
    return match ? `Last activity · ${match[2]} · ${match[1]}` : `Last activity · ${replayActivity}`;
  }
  return companion.state === 'connected' ? 'No agent active right now.'
    : companion.state === 'working' ? 'Activity details unavailable' : companion.description;
};
