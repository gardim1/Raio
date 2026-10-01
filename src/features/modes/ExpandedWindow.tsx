import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { Button, IconButton } from '../../shared/ui/Button';
import { CollapseIcon, PinIcon, PlayIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import type { ArchitectureGraph, NodeId } from '../architecture/model/types';
import { PanelFooter } from '../panel/PanelFooter';
import { TitleBar } from '../panel/TitleBar';
import { AGENT_LABEL, formatOffset } from '../session/model/events';
import type { FrameState } from '../session/model/evaluateFrame';
import type { SessionInsights } from '../session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../session/model/script';
import { EventTimeline } from './EventTimeline';
import { NodeInspector } from './NodeInspector';
import { MORPH_TRANSITION, type Presence } from './presence';

export interface ExpandedWindowProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly graph: ArchitectureGraph;
  readonly project: string;
  readonly insights: SessionInsights;
  readonly presence: Presence;
  readonly selectedNodeId: NodeId | null;
  readonly replay?: ReactNode;
  readonly isReplay: boolean;
  readonly onSelectNode: (id: NodeId | null) => void;
  readonly onSelectEvent: (event: StoryEvent) => void;
  readonly onPinMini: () => void;
  readonly onIsland: () => void;
  readonly onViewChanges: () => void;
}

interface Tooltip {
  readonly id: NodeId;
  readonly x: number;
  readonly y: number;
}

/**
 * Expanded Mode — the canonical panel grown into a full window: the 1000×520 map stays
 * exactly as in the concept; a 280px sidebar adds session overview, inspector and events.
 */
export const ExpandedWindow = ({
  script,
  frame,
  graph,
  project,
  insights,
  presence,
  selectedNodeId,
  replay,
  isReplay,
  onSelectNode,
  onSelectEvent,
  onPinMini,
  onIsland,
  onViewChanges,
}: ExpandedWindowProps) => {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const selected = selectedNodeId ? graph.nodeById.get(selectedNodeId) : undefined;
  const hovered = tooltip ? graph.nodeById.get(tooltip.id) : undefined;
  const hoveredFrame = tooltip ? frame.nodes.get(tooltip.id) : undefined;

  return (
    <div className="expanded-dock">
      <motion.div layoutId="raio-surface" layoutDependency="expanded" transition={MORPH_TRANSITION} className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar
          project={project}
          agent={script.agent}
          task={script.task}
          taskVisible={frame.ui.taskVisible}
          status={frame.ui.status}
          {...(isReplay ? { statusLabel: frame.ui.finished ? 'Replay complete' : 'Replay', taskPrefix: `Replay of a ${formatOffset(insights.durationMs)} session:` } : {})}
          actions={
            <>
              <IconButton label="Pin as mini player" onClick={onPinMini}>
                <PinIcon />
              </IconButton>
              <IconButton label="Tuck into Island" onClick={onIsland}>
                <CollapseIcon />
              </IconButton>
            </>
          }
        />
        <div className="expanded__body">
          <div className="map expanded__map">
            <ArchitectureCanvas
              graph={graph}
              frame={frame}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => onSelectNode(id === selectedNodeId ? null : id)}
              onHoverNode={(id, el) => {
                if (!id || !el) return setTooltip(null);
                const r = el.getBoundingClientRect();
                setTooltip({ id, x: r.left + r.width / 2, y: r.top });
              }}
              className="map__svg"
            />
          </div>
          <aside className="sidebar">
            <div className="sidebar__scroll">
            <div className="sidebar__overview">
              <div className="sidebar__eyebrowless">{AGENT_LABEL[script.agent]} Code</div>
              <div className="sidebar__task">{script.task}</div>
              <div className="sidebar__meta">
                {formatOffset(insights.durationMs)} session, {insights.filesChanged} files changed
              </div>
            </div>
            {selected ? (
              <NodeInspector node={selected} frame={frame.nodes.get(selected.id)} insight={insights.byNode.get(selected.id)} onClose={() => onSelectNode(null)} />
            ) : (
              <p className="sidebar__hint">Select a system on the map to see what changed.</p>
            )}
            <h4 className="sidebar__section">Session</h4>
            <EventTimeline events={script.story} t={frame.t} selectedNodeId={selectedNodeId} onSelect={onSelectEvent} />
            </div>
          </aside>
        </div>
        <PanelFooter
          script={script}
          frame={frame}
          center={replay}
          {...(isReplay ? { followingLabel: 'Replaying session' } : {})}
          trailing={
            presence.cta !== 'hidden' ? (
              <Button className={presence.cta === 'quiet' ? 'btn--quiet' : ''} icon={<PlayIcon />} onClick={onViewChanges}>
                View changes
              </Button>
            ) : null
          }
        />
      </motion.div>
      {tooltip && hovered && (
        <div className="tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          <strong>{hovered.label}</strong>
          <span>{hoveredFrame?.touched ? (hoveredFrame.activation > 0 ? hoveredFrame.detail : 'Not reached yet') : 'Untouched'}</span>
        </div>
      )}
    </div>
  );
};
