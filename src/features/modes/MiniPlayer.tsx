import { type ReactNode } from 'react';
import { Button } from '../../shared/ui/Button';
import { PlayIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import type { ArchitectureGraph } from '../architecture/model/types';
import { statusLabel } from '../../shared/ui/AgentStatus';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { type Presence } from './presence';
import { MiniSurface } from './MiniSurface';
import { useSessionSnapshot } from '../../platform/BridgeContext';
import { lastRecordedSession } from '../session/model/lastRecordedSession';

export interface MiniPlayerProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly graph: ArchitectureGraph;
  readonly project: string;
  readonly presence: Presence;
  readonly pinned: boolean;
  readonly replay?: ReactNode;
  /** Overrides the header state text (e.g. "Replay"). */
  readonly stateLabel?: string;
  readonly onTogglePin: () => void;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onViewChanges: () => void;
}

/**
 * Mini Player — a calm picture-in-picture window (380×250 default; 300–560 × 200–380).
 * Drag by the header, resize from the corner; optionally always-on-top (pin).
 */
export const MiniPlayer = ({ script, frame, graph, project, presence, pinned, replay, stateLabel, onTogglePin, onExpand, onCollapse, onViewChanges }: MiniPlayerProps) => {
  const { ui } = frame;
  const recorded = useSessionSnapshot();
  return (
    <MiniSurface project={project} projectTitle={lastRecordedSession(recorded?.log ?? null)} status={ui.status} stateLabel={stateLabel ?? statusLabel(ui.status, script.agent)} pinned={pinned}
      onTogglePin={onTogglePin} onExpand={onExpand} onCollapse={onCollapse} footer={replay ? (
        <div className="mini__foot mini__foot--replay">{replay}</div>
      ) : presence.cta !== 'hidden' ? (
        <div className="mini__foot">
          <span className="mini__foot-text">
            {script.summary.systems} systems, {script.summary.reviewCount} to review
          </span>
          <Button className={presence.cta === 'quiet' ? 'btn--quiet' : ''} icon={<PlayIcon />} onClick={onViewChanges}>
            View changes
          </Button>
        </div>
      ) : null}>
      <ArchitectureCanvas graph={graph} frame={frame} variant="mini" camera={false} fit="content" className="mini__svg" />
      {ui.activeRisk && (
        <span className="mini__risk" style={{ opacity: frame.risks[0]?.pill.opacity ?? 1 }}><i />{ui.activeRisk.label}</span>
      )}
    </MiniSurface>
  );
};
