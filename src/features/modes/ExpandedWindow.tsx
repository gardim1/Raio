import { motion } from 'motion/react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type ReactNode, useMemo, useState } from 'react';
import { agentFullName } from '../../shared/ui/agentName';
import { Button, IconButton } from '../../shared/ui/Button';
import { IslandIcon, PictureInPictureIcon, PlayIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import type { ArchitectureGraph, NodeId } from '../architecture/model/types';
import { PanelFooter } from '../panel/PanelFooter';
import { TitleBar, type TitleBarWindowApi } from '../panel/TitleBar';
import { formatOffset } from '../session/model/events';
import type { FrameState } from '../session/model/evaluateFrame';
import type { SessionInsights } from '../session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../session/model/script';
import type { CompanionPresence } from './companionPresence';
import { PresenceHistory } from './PresenceHistory';
import { EventTimeline } from './EventTimeline';
import { NodeInspector } from './NodeInspector';
import { MORPH_TRANSITION, type Presence } from './presence';
import { useSessionMeta } from './sessionMeta';
import { EvidencePanel } from '../panel/EvidencePanel';
import { ConnectionFooter } from '../panel/ConnectionFooter';
import { useBridge, useSessionSnapshot } from '../../platform/BridgeContext';
import type { DesktopBridge } from '../../platform/desktopBridge';
import { lastRecordedSession } from '../session/model/lastRecordedSession';

/** Matches the Windows-only chrome configuration in surfaces.rs; the harness never opens a native API. */
export const expandedWindowChrome = (
  bridge: Pick<DesktopBridge, 'kind' | 'fixedSurface'>,
  userAgent: string,
  getWindow: () => TitleBarWindowApi = getCurrentWindow,
): TitleBarWindowApi | undefined =>
  bridge.kind === 'native' && bridge.fixedSurface === 'expanded' && /Windows/.test(userAgent) ? getWindow() : undefined;

export interface ExpandedWindowProps {
  readonly companion?: CompanionPresence;
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
  companion,
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
  const snapshotNow = useSessionSnapshot();
  const evidence = snapshotNow?.evidence;
  const bridge = useBridge();
  const connector = bridge.connector;
  const nativeWindow = useMemo(() => expandedWindowChrome(bridge, typeof navigator === 'undefined' ? '' : navigator.userAgent), [bridge]);
  const agentFull = agentFullName(script.agent);
  // Before the agent starts the sidebar describes the repository; while it works, the live session; afterwards, the finished one.
  const overview =
    !isReplay && frame.ui.status === 'ready'
      ? { eyebrow: project, title: `${graph.nodes.length} ${graph.nodes.length === 1 ? 'system' : 'systems'} mapped`, meta: `Start ${agentFull} in this repository` }
      : {
          eyebrow: agentFull,
          title: script.task,
          meta: !isReplay && frame.ui.status === 'working' ? (startedAt ? `Live session, started ${startedAt}` : 'Live session') : `${formatOffset(insights.durationMs)} session, ${insights.filesChanged} ${insights.filesChanged === 1 ? 'file' : 'files'} changed`,
        };
  const selected = selectedNodeId ? graph.nodeById.get(selectedNodeId) : undefined;
  const hovered = tooltip ? graph.nodeById.get(tooltip.id) : undefined;
  const hoveredFrame = tooltip ? frame.nodes.get(tooltip.id) : undefined;

  return (
    <div className="expanded-dock">
      <motion.div layoutId="raio-surface" layoutDependency="expanded" transition={MORPH_TRANSITION} className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar
          companion={companion}
          nativeWindow={nativeWindow}
          project={project}
          agent={script.agent}
          task={script.task}
          taskIsPlaceholder={script.taskIsPlaceholder === true}
          taskVisible={frame.ui.taskVisible}
          status={frame.ui.status}
          {...(isReplay ? { statusLabel: frame.ui.finished ? 'Replay complete' : 'Replay', taskPrefix: `Replay of a ${formatOffset(insights.durationMs)} session:` } : {})}
          actions={
            <>
              <IconButton label="Open Mini Player" onClick={onPinMini}>
                <PictureInPictureIcon />
              </IconButton>
              <IconButton label="Show as Island" onClick={onIsland}>
                <IslandIcon />
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
            <p className="evidence__note">{lastRecordedSession(snapshotNow?.log ?? null, undefined, { live: !isReplay && script.live?.open === true })}</p>
            {companion && <PresenceHistory presence={companion} />}
            {selected ? (
              <NodeInspector node={selected} frame={frame.nodes.get(selected.id)} insight={insights.byNode.get(selected.id)} onClose={() => onSelectNode(null)} />
            ) : (
              <p className="sidebar__hint">Select a system on the map to see what changed.</p>
            )}
            <h4 className="sidebar__section">Session</h4>
            <EventTimeline events={script.story} agent={script.agent} t={frame.t} seekable={isReplay} selectedNodeId={selectedNodeId} onSelect={onSelectEvent} />
            {evidence && <EvidencePanel evidence={evidence} core={snapshotNow?.core} />}
            {connector && <ConnectionFooter connector={connector} />}
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
