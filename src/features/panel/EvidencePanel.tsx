import { formatOffset } from '../session/model/events';
import type { CoreHealth } from '../../platform/desktopBridge';
import type { ProjectInsights } from '../project/projectInsights';
import { currentValidations, describeValidation, UNASSIGNED_CHANGE_NOTE } from '../project/projectInsights';

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
            <span className="evidence__path">{describeValidation(v)}</span>
            <span className="evidence__meta">
              {v.status === 'stale' ? `last result: passed · code changed ${formatOffset(v.staleSinceMs ?? v.atMs)}` : `result at ${formatOffset(v.atMs)}`}
              {v.codeChangedSinceMs !== undefined ? ` · code changed ${formatOffset(v.codeChangedSinceMs)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    )}
    {core && core.dropped > 0 && <p className="evidence__warn">{core.dropped} event(s) could not be recorded; this session may be incomplete.</p>}
    {core?.watcherOverflow && <p className="evidence__warn">The file watcher overflowed; some disk changes may be missing.</p>}
    {core?.historyResetFrom && <p className="evidence__warn">Local history was unreadable and was moved aside; earlier sessions are not shown.</p>}
    {core && !core.hookBinary && <p className="evidence__warn">raio-hook was not found next to Raio; new agent events cannot be recorded.</p>}
    {evidence.technologies && evidence.technologies.length > 0 && (
      <ul className="evidence__list" aria-label="Technologies">
        {evidence.technologies.map((line) => (
          <li key={line} className="evidence__item">
            <span className="evidence__path" title={line}>
              {line}
            </span>
            <span className="evidence__meta">named in manifests (names only, heuristic)</span>
          </li>
        ))}
      </ul>
    )}
    {evidence.parallel && <p className="evidence__note">Activity from {evidence.actors} agents overlapped; Raio does not infer an order between them.</p>}
    <p className="evidence__note">{evidence.note}</p>
  </section>
  );
};
