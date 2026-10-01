import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { agentFullName } from '../../shared/ui/agentName';
import { Button, IconButton } from '../../shared/ui/Button';
import { CollapseIcon, PinIcon, PlayIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import type { ArchitectureGraph, NodeId } from '../architecture/model/types';
import { PanelFooter } from '../panel/PanelFooter';
import { TitleBar } from '../panel/TitleBar';
import { formatOffset } from '../session/model/events';
import type { FrameState } from '../session/model/evaluateFrame';
import type { SessionInsights } from '../session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../session/model/script';
import { EventTimeline } from './EventTimeline';
import { NodeInspector } from './NodeInspector';
import { MORPH_TRANSITION, type Presence } from './presence';
import { useSessionMeta } from './sessionMeta';

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
  const { startedAt } = useSessionMeta();
  const agentFull = agentFullName(script.agent);
  // Before the agent starts the sidebar describes the repository; while it works, the live session; afterwards, the finished one.
  const overview =
    !isReplay && frame.ui.status === 'ready'
      ? { eyebrow: project, title: `${graph.nodes.length} systems mapped`, meta: `Start ${agentFull} in this repository` }
      : {
          eyebrow: agentFull,
          title: script.task,
          meta: !isReplay && frame.ui.status === 'working' ? (startedAt ? `Live session, started ${startedAt}` : 'Live session') : `${formatOffset(insights.durationMs)} session, ${insights.filesChanged} files changed`,
        };
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
              <div className="sidebar__eyebrowless">{overview.eyebrow}</div>
              <div className="sidebar__task">{overview.title}</div>
              <div className="sidebar__meta">{overview.meta}</div>
            </div>
            {selected ? (
              <NodeInspector node={selected} frame={frame.nodes.get(selected.id)} insight={insights.byNode.get(selected.id)} onClose={() => onSelectNode(null)} />
            ) : (
              <p className="sidebar__hint">Select a system on the map to see what changed.</p>
            )}
            <h4 className="sidebar__section">Session</h4>
            <EventTimeline events={script.story} agent={script.agent} t={frame.t} seekable={isReplay} selectedNodeId={selectedNodeId} onSelect={onSelectEvent} />
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
          <span>{hoveredFrame?.touched ? (hoveredFrame.activation > 0.01 ? hoveredFrame.detail : 'Not reached yet') : 'Not touched in this session'}</span>
        </div>
      )}
    </div>
  );
};
