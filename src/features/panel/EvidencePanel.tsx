import { formatOffset } from '../session/model/events';
import type { CoreHealth } from '../../platform/desktopBridge';
import { HOOK_BINARY_MISSING_NOTE } from '../../platform/coreHealth';
import type { ProjectInsights } from '../project/projectInsights';
import { currentValidations, describeValidation, UNASSIGNED_CHANGE_NOTE } from '../project/projectInsights';
import { AboutMap } from './AboutMap';
import { coreWarnings, splitMapNotes } from './sidebarState';

const DISK_LABEL = {
  consistent: 'reported, consistent on disk',
  'not-observed': 'reported only (no disk change seen)',
} as const;

/**
 * What the evidence does and does not show for a live session: reported edits versus what the
 * filesystem saw, changes nobody reported, parallel activity, and the heuristic nature of the map.
 */
export const EvidencePanel = ({ evidence, core }: { readonly evidence: ProjectInsights; readonly core?: CoreHealth | undefined }) => {
  const checks = currentValidations(evidence.validations);
  const notes = splitMapNotes(evidence.note);
  return (
  <section className="evidence" aria-label="Evidence">
    <h4 className="sidebar__section">Evidence</h4>
    {evidence.reportedEdits.length === 0 && <p className="sidebar__hint">No edits reported in this session.</p>}
    <ul className="evidence__list">
      {evidence.reportedEdits.map((e) => (
        <li key={`${e.path}-${e.atMs}`} className={`evidence__item evidence__item--${e.disk}`}>
          <span className="evidence__path" title={e.path}>
            {e.path}
          </span>
          <span className="evidence__meta">
            {DISK_LABEL[e.disk]}
            {e.concurrentChange ? ', another change nearby (low confidence)' : ''} · {formatOffset(e.atMs)}
          </span>
        </li>
      ))}
      {evidence.unassigned.map((c) => (
        <li key={`u-${c.path}-${c.atMs}`} className="evidence__item evidence__item--unassigned">
          <span className="evidence__path" title={c.path}>
            {c.path}
          </span>
          <span className="evidence__meta">
            {UNASSIGNED_CHANGE_NOTE} · {formatOffset(Math.max(0, c.atMs))}
          </span>
        </li>
      ))}
    </ul>
    {checks.length > 0 && (
      <ul className="evidence__list" aria-label="Checks">
        {checks.map((v) => (
          <li key={v.kind} className="evidence__item">
            <span className="evidence__path" title={describeValidation(v)}>{describeValidation(v)}</span>
            <span className="evidence__meta">
              {v.status === 'stale' ? `last result: passed · code changed ${formatOffset(v.staleSinceMs ?? v.atMs)}` : `result at ${formatOffset(v.atMs)}`}
              {v.codeChangedSinceMs !== undefined ? ` · code changed ${formatOffset(v.codeChangedSinceMs)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    )}
    {[...coreWarnings(core), ...(core && !core.hookBinary ? [HOOK_BINARY_MISSING_NOTE] : []), ...notes.warnings].map(line =>
      <p className="evidence__warn" role="status" aria-label={line} key={line}>{line}</p>)}
    {evidence.parallel && <p className="evidence__note">Activity from {evidence.actors} agents overlapped; Raio does not infer an order between them.</p>}
    <AboutMap details={notes.details} technologies={evidence.technologies} />
  </section>
  );
};
