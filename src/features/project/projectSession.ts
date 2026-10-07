import type { SessionSnapshot } from '../../platform/desktopBridge';
import type { RaioEvent } from '../ingest/raioEvent';
import type { AgentEvent, SessionLog } from '../session/model/events';
import type { AgentId, ValidationKind, ValidationStatus } from '../session/model/script';
import { classifyPath, groupPaths, OTHER_GROUP, type PathGroup } from './classifyPath';
import { assessReportedEdits, DISK_WINDOW_MS, findUnassignedChanges, firstChangeAfter, type PathMoment } from './diskEvidence';
import { deriveMapImportEdges, drawnLinks, type ProjectImports, relationshipsFrom, relationshipsNote } from './importEdges';
import { groupInventory, inventoryNotes } from './inventoryGroups';
import { noticeKindForPath } from './pathKinds';
import type { ProjectedSession, ProjectInsights, ReportedEditInsight, UnassignedChangeInsight, ValidationInsight } from './projectInsights';
import { layoutGroups } from './layoutGroups';
import type { ProjectInventory } from './projectInventory';

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
 * and `deriveInsights` consume unchanged, a group map, and the extra evidence the log cannot carry
 * (disk consistency, unassigned changes, stale checks, parallel activity). The map has edges only when
 * `imports` (a TS/JS static import scan) produced them between groups on the map; the session's activity
 * never creates one, and without a scan (or without TS/JS files) relationships stay unknown. `importsStale`: a later
 * rescan failed, so the relationships are as of the last scan that worked.
 *
 * With an `inventory` (the project's file listing and the names its manifests state) the areas come from the whole
 * project: the 12 largest by file count (ties by name), however the session went, so nodes never move between sessions
 * of the same listing. Areas the session did not touch are on the map too and show dimmed (they have no cues in the
 * replay). Whatever the session touched outside those 12 (a smaller area, a file the listing does not hold, a loose root
 * file) is inside `Other`, which then has cues and lists it; `Other` is laid out even while empty, for the same reason.
 * `inventoryStale`: a later relisting failed, so the areas are as of the last listing. Without an inventory, the areas
 * are the paths the session touched, as before.
 *
 * `events` are all events of the project (any session, plus filesystem changes): staleness and
 * attribution need the whole project. Returns null when there are no agent events ("no telemetry").
 * Everything about groups, consistency and staleness is a heuristic; see HEURISTIC_NOTE and diskEvidence.ts.
 */
export const projectSessionDetailed = (
  project: ProjectRef,
  events: readonly RaioEvent[],
  sessionId?: string,
  imports?: ProjectImports | null,
  importsStale = false,
  inventory?: ProjectInventory | null,
  inventoryStale = false,
): ProjectedSession | null => {
  const projectEvents = events.filter((e) => e.projectId === project.id);
  const selected = pickSession(projectEvents.filter(isAgentEvent), sessionId);
  if (!selected) return null;
  const sessionEvents = [...selected].sort(compareEvents);
  const first = sessionEvents[0]!;
  const startAt = timeOf(first);
  const lastAt = timeOf(sessionEvents.at(-1)!);
  const atMs = (event: RaioEvent): number => Math.max(0, timeOf(event) - startAt);
  const lastAtMs = Math.max(0, lastAt - startAt);

  const groupedPaths = sessionEvents.filter((e) => e.kind === 'file.inspected' || e.kind === 'file.edit.reported').flatMap((e) => e.paths);
  const mapOfProject = inventory ? groupInventory(inventory, groupedPaths) : null;
  const sessionGroups = mapOfProject ? null : groupPaths(groupedPaths);
  const groups = mapOfProject ? mapOfProject.groups : sessionGroups!.groups;
  const areaOf = (path: string): PathGroup => (mapOfProject ? mapOfProject.classify(path) : (sessionGroups!.groupOf.get(path) ?? classifyPath(path)));
  const nodeOf = (path: string): string => areaOf(path).groupId;

  // Disk evidence is project-wide: another session's edit can explain a change, and any change makes a result stale.
  const changes: PathMoment[] = projectEvents.filter((e) => e.kind === 'file.changed').flatMap((e) => e.paths.map((path) => ({ path, at: timeOf(e) })));
  const projectEdits = projectEvents.filter((e) => e.kind === 'file.edit.reported' && isAgentEvent(e)).flatMap((e) => e.paths.map((path) => ({ path, at: timeOf(e), session: e.sessionId })));
  const editMoments: PathMoment[] = projectEdits.map(({ path, at }) => ({ path, at }));

  const log: AgentEvent[] = [];
  const validations: ValidationInsight[] = [];
  const noticed = new Set<string>();
  const kindOfTool = new Map<string, ValidationKind>();
  let lastBoundary: RaioEvent | undefined;

  for (const event of sessionEvents) {
    if (event.kind === 'session.started' || event.kind === 'session.ended') {
      // Ignore an exact repeat delivery, not another occurrence at a later position in the event order.
      if (lastBoundary?.kind === event.kind && compareEvents(lastBoundary, event) === 0) continue;
      lastBoundary = event;
    }
    const at = atMs(event);
    switch (event.kind) {
      case 'session.started':
        log.push({ kind: 'session.start', atMs: at });
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
        // The result is logged with the status it had when it happened; what the project did afterwards is history.
        const recorded = statusFromExit(event.evidence.exitCode);
        const detail = recorded === 'unknown' && event.evidence.detail !== undefined ? { detail: event.evidence.detail } : {};
        const changedAt = recorded === 'passed' || recorded === 'failed' ? firstChangeAfter(timeOf(event), changes, editMoments) : undefined;
        const changedSinceMs = changedAt === undefined ? undefined : Math.max(0, changedAt - startAt);
        log.push({ kind: 'validation', atMs: at, validation: kind, status: recorded, ...detail });
        if (changedSinceMs === undefined) {
          validations.push({ kind, status: recorded, recordedStatus: recorded, atMs: at, ...detail });
        } else if (recorded === 'passed') {
          // A pass the project outlived gets a later `stale` entry at the change time (never past the session's last event).
          const staleAt = Math.min(changedSinceMs, lastAtMs);
          log.push({ kind: 'validation', atMs: staleAt, validation: kind, status: 'stale' });
          validations.push({ kind, status: recorded, recordedStatus: recorded, atMs: at });
          validations.push({ kind, status: 'stale', recordedStatus: recorded, atMs: staleAt, staleSinceMs: changedSinceMs });
        } else {
          // A failure is never turned stale, hidden or greened by later edits: it stays failed and says the code changed.
          validations.push({ kind, status: recorded, recordedStatus: recorded, atMs: at, codeChangedSinceMs: changedSinceMs });
        }
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

  // Stale entries are logged when the result is processed but belong at the change time: restore time order
  // (stable, so entries at the same millisecond keep their processing order).
  log.sort((a, b) => a.atMs - b.atMs);
  validations.sort((a, b) => a.atMs - b.atMs);

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
      const group: PathGroup = areaOf(c.path);
      return { path: c.path, groupId: group.groupId, groupLabel: group.label, atMs: c.at - startAt, notice: noticeKindForPath(c.path) };
    });

  // Edges come from the import scan only, between groups that are on the map; a path in a group that was merged into Other counts as Other.
  const mapped = new Set(groups.map((g) => g.groupId));
  const derived = imports
    ? mapOfProject
      ? deriveMapImportEdges(imports, mapped, new Set(), mapOfProject.classify)
      : deriveMapImportEdges(imports, mapped, new Set(groupedPaths.map((path) => classifyPath(path).groupId)))
    : null;
  const relationships = derived ? relationshipsFrom(derived, { stale: importsStale }) : 'unknown';
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
    // Other is laid out even while it is empty, so the areas never move when a session first touches something outside the listing.
    graph: layoutGroups(groups, derived ? drawnLinks(derived.edges) : [], mapOfProject && !groups.some((g) => g.groupId === OTHER_GROUP.groupId) ? [OTHER_GROUP] : []),
    log: sessionLog,
  };
  const insights: ProjectInsights = {
    note: [relationshipsNote(relationships, inventory ? 'inventory' : 'sessions'), ...(inventory ? inventoryNotes(inventory, { stale: inventoryStale }) : [])].join(' '),
    relationships,
    ...(mapOfProject && mapOfProject.technologies.length > 0 ? { technologies: mapOfProject.technologies } : {}),
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
