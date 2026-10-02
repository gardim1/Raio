import { IconButton } from '../../shared/ui/Button';
import { CloseIcon } from '../../shared/ui/icons';
import { RiskPill } from '../../shared/ui/RiskPill';
import type { ArchitectureNode } from '../architecture/model/types';
import type { NodeFrame } from '../session/model/evaluateFrame';
import type { NodeInsight } from '../session/model/insights';

export interface NodeInspectorProps {
  readonly node: ArchitectureNode;
  readonly frame: NodeFrame | undefined;
  readonly insight: NodeInsight | undefined;
  readonly onClose: () => void;
}

const CHANGE_LABEL = { added: 'Added', modified: 'Edited', deleted: 'Deleted' } as const;

/** Details for the selected system: state, files touched, risks. */
export const NodeInspector = ({ node, frame, insight, onClose }: NodeInspectorProps) => {
  const touched = frame?.touched ?? false;
  const reached = (frame?.activation ?? 0) > 0.01;
  const warning = frame?.tone === 'warning' && frame.toneAmount > 0.5;
  const state = !touched ? 'Not touched in this session' : !reached ? 'Not reached yet' : warning ? 'Worth reviewing' : 'Changed';
  // Files and risks appear only once Raio has reached the system (no spoilers), and risks only while it is flagged.
  const detail = touched && reached ? insight : undefined;
  return (
    <section className="inspector" aria-label={`${node.label} details`}>
      <header className="inspector__head">
        <span className={`inspector__dot${warning ? ' inspector__dot--warning' : touched ? ' inspector__dot--cool' : ''}`} />
        <h3>{node.label}</h3>
        <IconButton label="Close details" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      <p className="inspector__state">{state}</p>
      {node.hint && <p className="inspector__state">{node.hint} · named in manifests (heuristic)</p>}
      {node.members && node.members.length > 0 && <p className="inspector__state">Includes areas this session touched: {node.members.join(', ')}</p>}
      {warning && detail?.risks.map((r, i) => (
        <div key={i} className="inspector__risk">
          <RiskPill kind={r.kind} />
          <p>{r.detail}</p>
        </div>
      ))}
      {detail && detail.files.length > 0 && (
        <ul className="inspector__files">
          {detail.files.map((f) => (
            <li key={f.path}>
              <span className={`inspector__change inspector__change--${f.change}`}>{CHANGE_LABEL[f.change]}</span>
              <code title={f.path}>{f.path}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
