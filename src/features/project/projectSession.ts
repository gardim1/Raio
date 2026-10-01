import type { SessionSnapshot } from '../../platform/desktopBridge';
import type { RaioEvent } from '../ingest/raioEvent';
import type { AgentEvent, SessionLog } from '../session/model/events';
import type { AgentId, ValidationKind, ValidationStatus } from '../session/model/script';
import { classifyPath, groupPaths, HEURISTIC_NOTE, type PathGroup } from './classifyPath';
import { assessReportedEdits, DISK_WINDOW_MS, findUnassignedChanges, firstChangeAfter, type PathMoment } from './diskEvidence';
import { noticeKindForPath } from './pathKinds';
import type { ProjectedSession, ProjectInsights, ReportedEditInsight, UnassignedChangeInsight, ValidationInsight } from './projectInsights';
import { layoutGroups } from './layoutGroups';

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

const timeOf = (event: RaioEvent): number => event.sourceAt ?? event.observedAt;
const compareEvents = (a: RaioEvent, b: RaioEvent): number => timeOf(a) - timeOf(b) || a.seq - b.seq || a.id.localeCompare(b.id);

/** Agent telemetry is session-attributed hook activity; disk changes are evidence, not agent events. */
const isAgentEvent = (event: RaioEvent): boolean => event.sessionId !== undefined && event.attribution === 'session' && event.kind !== 'file.changed';

const pickSession = (agentEvents: readonly RaioEvent[], requested: string | undefined): readonly RaioEvent[] | null => {
  const bySession = new Map<string, RaioEvent[]>();
  for (const event of agentEvents) {
    const list = bySession.get(event.sessionId!);
    if (list) list.push(event);
    else bySession.set(event.sessionId!, [event]);
  }
  if (requested !== undefined) return bySession.get(requested) ?? null;
  let best: { id: string; last: RaioEvent } | null = null;
  for (const [id, list] of bySession) {
    const last = list.reduce((a, b) => (compareEvents(a, b) >= 0 ? a : b));
    if (!best || compareEvents(last, best.last) > 0 || (compareEvents(last, best.last) === 0 && id.localeCompare(best.id) > 0)) best = { id, last };
  }
  return best ? bySession.get(best.id)! : null;
};

const localClock = (epochMs: number): string => {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const VALIDATION_BY_CLASS: Readonly<Record<string, ValidationKind>> = { test: 'tests', build: 'build' };

/** Exit code to result: 0 passed, any other captured code failed, none captured unknown. */
const statusFromExit = (exitCode: number | undefined): ValidationStatus => (exitCode === undefined ? 'unknown' : exitCode === 0 ? 'passed' : 'failed');

/** Actors (main agent and subagents) whose activity spans overlap are running in parallel. Overlap only; no causality. */
const detectParallel = (events: readonly RaioEvent[]): { parallel: boolean; actors: number } => {
  const spans = new Map<string, { min: number; max: number }>();
  for (const event of events) {
    if (!event.kind.startsWith('file.') && !event.kind.startsWith('command.')) continue;
    const actor = event.subagentId ?? 'main';
    const at = timeOf(event);
    const span = spans.get(actor);
    if (span) {
      span.min = Math.min(span.min, at);
      span.max = Math.max(span.max, at);
    } else spans.set(actor, { min: at, max: at });
  }
  const all = [...spans.values()];
  const parallel = all.some((a, i) => all.slice(i + 1).some((b) => a.min < b.max && b.min < a.max));
  return { parallel, actors: spans.size };
};

/**
 * Projects the project's events into the session the surfaces show: a `SessionLog` that `compileReplay`
 * and `deriveInsights` consume unchanged, a group map without edges, and the extra evidence the log
 * cannot carry (disk consistency, unassigned changes, stale checks, parallel activity).
 *
 * `events` are all events of the project (any session, plus filesystem changes): staleness and
 * attribution need the whole project. Returns null when there are no agent events ("no telemetry").
 * Everything about groups, consistency and staleness is a heuristic; see HEURISTIC_NOTE and diskEvidence.ts.
 */
export const projectSessionDetailed = (project: ProjectRef, events: readonly RaioEvent[], sessionId?: string): ProjectedSession | null => {
  const projectEvents = events.filter((e) => e.projectId === project.id);
  const selected = pickSession(projectEvents.filter(isAgentEvent), sessionId);
  if (!selected) return null;
  const sessionEvents = [...selected].sort(compareEvents);
  const first = sessionEvents[0]!;
  const startAt = timeOf(first);
  const lastAt = timeOf(sessionEvents.at(-1)!);
  const atMs = (event: RaioEvent): number => Math.max(0, timeOf(event) - startAt);

  const groupedPaths = sessionEvents.filter((e) => e.kind === 'file.inspected' || e.kind === 'file.edit.reported').flatMap((e) => e.paths);
  const { groups, groupOf } = groupPaths(groupedPaths);
  const nodeOf = (path: string): string => (groupOf.get(path) ?? classifyPath(path)).groupId;

  // Disk evidence is project-wide: another session's edit can explain a change, and any change makes a result stale.
  const changes: PathMoment[] = projectEvents.filter((e) => e.kind === 'file.changed').flatMap((e) => e.paths.map((path) => ({ path, at: timeOf(e) })));
  const projectEdits = projectEvents.filter((e) => e.kind === 'file.edit.reported' && isAgentEvent(e)).flatMap((e) => e.paths.map((path) => ({ path, at: timeOf(e), session: e.sessionId })));
  const editMoments: PathMoment[] = projectEdits.map(({ path, at }) => ({ path, at }));

  const log: AgentEvent[] = [];
  const validations: ValidationInsight[] = [];
  const noticed = new Set<string>();
  const kindOfTool = new Map<string, ValidationKind>();
  let sawStart = false;

  for (const event of sessionEvents) {
    const at = atMs(event);
    switch (event.kind) {
      case 'session.started':
        if (!sawStart) log.push({ kind: 'session.start', atMs: at });
        sawStart = true;
        break;
      case 'file.inspected':
        for (const path of event.paths) log.push({ kind: 'file.read', atMs: at, path, nodeId: nodeOf(path) });
        break;
      case 'file.edit.reported':
        for (const path of event.paths) {
          const change = event.evidence.change;
          log.push({ kind: 'file.write', atMs: at, path, nodeId: nodeOf(path), change: change === 'added' || change === 'deleted' ? change : 'modified' });
          const notice = noticeKindForPath(path);
          if (notice && !noticed.has(path)) {
            noticed.add(path);
            log.push({ kind: 'risk', atMs: at, nodeId: nodeOf(path), risk: notice, detail: path });
          }
        }
        break;
      case 'command.observed': {
        const kind = event.evidence.commandClass ? VALIDATION_BY_CLASS[event.evidence.commandClass] : undefined;
        if (!kind) break;
        if (event.evidence.toolUseId) kindOfTool.set(event.evidence.toolUseId, kind);
        log.push({ kind: 'validation', atMs: at, validation: kind, status: 'running' });
        validations.push({ kind, status: 'running', recordedStatus: 'running', atMs: at });
        break;
      }
      case 'command.result': {
        const kind = (event.evidence.toolUseId ? kindOfTool.get(event.evidence.toolUseId) : undefined) ?? (event.evidence.commandClass ? VALIDATION_BY_CLASS[event.evidence.commandClass] : undefined);
        if (!kind) break;
        const recorded = statusFromExit(event.evidence.exitCode);
        // Only a pass can go stale: a failure stays visible as a failure (never hidden by later edits).
        const changedAt = recorded === 'passed' ? firstChangeAfter(timeOf(event), changes, editMoments) : undefined;
        const status: ValidationStatus = changedAt === undefined ? recorded : 'stale';
        log.push({ kind: 'validation', atMs: at, validation: kind, status });
        validations.push({ kind, status, recordedStatus: recorded, atMs: at, ...(changedAt === undefined ? {} : { staleSinceMs: Math.max(0, changedAt - startAt) }) });
        break;
      }
      case 'session.ended':
        log.push({ kind: 'session.end', atMs: at, outcome: 'completed' });
        break;
      default:
        // turn.ended, file.edit.attempted and file.edit.failed say nothing the replay may claim.
        break;
    }
  }

  const assessments = assessReportedEdits(editMoments, changes);
  const reportedEdits: ReportedEditInsight[] = [];
  projectEdits.forEach((edit, i) => {
    if (edit.session !== first.sessionId) return;
    const a = assessments[i]!;
    reportedEdits.push({ path: edit.path, groupId: nodeOf(edit.path), atMs: Math.max(0, edit.at - startAt), disk: a.disk, confidence: a.confidence, concurrentChange: a.concurrentChange });
  });
  reportedEdits.sort((a, b) => a.atMs - b.atMs);

  const unassigned: UnassignedChangeInsight[] = findUnassignedChanges(changes, editMoments)
    .filter((c) => c.at >= startAt && c.at <= lastAt + DISK_WINDOW_MS)
    .sort((a, b) => a.at - b.at)
    .map((c) => {
      const group: PathGroup = classifyPath(c.path);
      return { path: c.path, groupId: group.groupId, groupLabel: group.label, atMs: c.at - startAt, notice: noticeKindForPath(c.path) };
    });

  const agent: AgentId = first.agent;
  const sessionLog: SessionLog = {
    id: first.sessionId!,
    agent,
    task: `Session started ${localClock(startAt)}`,
    taskIsPlaceholder: true,
    project: project.name,
    startedAt: new Date(startAt).toISOString(),
    events: log,
  };
  const snapshot: SessionSnapshot = {
    provenance: sessionEvents.some((e) => e.provenance === 'fixture' || e.source === 'fixture') ? 'fixture' : 'live',
    project: project.name,
    graph: layoutGroups(groups),
    log: sessionLog,
  };
  const insights: ProjectInsights = {
    note: HEURISTIC_NOTE,
    relationships: 'unknown',
    ...detectParallel(sessionEvents),
    reportedEdits,
    unassigned,
    validations,
  };
  return { snapshot, insights };
};

/** The session snapshot the bridge hands to the surfaces, or null when there is no agent telemetry. */
export const projectSession = (project: ProjectRef, events: readonly RaioEvent[], sessionId?: string): SessionSnapshot | null =>
  projectSessionDetailed(project, events, sessionId)?.snapshot ?? null;
