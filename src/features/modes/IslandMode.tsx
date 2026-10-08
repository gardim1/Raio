import { IslandShell } from './IslandShell';
import { AgentStatus } from '../../shared/ui/AgentStatus';
import { agentFullName, agentShortName } from '../../shared/ui/agentName';
import { IconButton } from '../../shared/ui/Button';
import { useBridge, useSessionSnapshot } from '../../platform/BridgeContext';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { islandActivity, islandObservedActivity } from './islandActivity';
import { ExpandIcon, PictureInPictureIcon } from '../../shared/ui/icons';
import { MiniOrb } from '../raio/MiniOrb';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { useSessionUi } from '../session/store/sessionStore';
import { islandOrbBobs, islandOrbState } from './islandOrbState';
import type { Presence } from './presence';
import type { CompanionPresence } from './companionPresence';
import { useSessionMeta } from './sessionMeta';

export interface IslandModeProps {
  readonly companion?: CompanionPresence;
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly presence: Presence;
  readonly onPinMini: () => void;
  readonly onExpand: () => void;
  readonly onViewChanges: () => void;
}

/** Session facts in the shared compact preview; only explicit mode buttons switch surfaces. */
export const IslandMode = ({ script, frame, presence, companion, onPinMini, onExpand }: IslandModeProps) => {
  const { ui, orb } = frame;
  const { project } = useSessionMeta();
  const snapshot = useSessionSnapshot();
  const bridge = useBridge();
  const observations = useSurfaceStore(bridge.subscribe, () => bridge.projectPresence?.() ?? null);
  const lastActivity = observations
    ? islandObservedActivity(observations.facts, Date.now())
    : `Last replay event · ${islandActivity(snapshot?.log ?? null)} · ${snapshot?.provenance === 'fixture' ? 'Demo fixture' : 'Recorded session log'}`;
  const replaying = useSessionUi((s) => s.source === 'replay');
  const agent = agentShortName(script.agent);
  const agentFull = agentFullName(script.agent);
  const working = ui.status === 'working';
  const recentActivity = companion ? companion.activeUntil !== null : working;
  const finished = ui.finished;
  const ready = ui.status === 'ready' && !replaying;
  const activityLabel = presence.activeNodeLabel ? `${agent} · ${presence.activeNodeLabel}` : companion?.label ?? `${agent} · starting`;
  const collapsedLabel = !replaying && !recentActivity && companion ? companion.label : replaying
    ? 'Replaying'
    : recentActivity
      ? activityLabel
      : presence.recentlyFinished
        ? `${agent} finished`
        : finished
          ? 'Idle'
          : 'Ready';
  const description = companion && collapsedLabel !== companion.label
    ? `${collapsedLabel} · ${companion.description}`
    : companion?.description ?? collapsedLabel;
  const orbState = islandOrbState({ working, replaying, recentlyFinished: presence.recentlyFinished, finished });
  const dotClass = working || replaying ? 'cool' : 'idle';

  return (
    <IslandShell description={description} collapsed={<>
      <MiniOrb companion={companion} size={14} glow={0.25 + orb.glowCool * 0.6} warm={orb.glowWarm} bob={islandOrbBobs(orbState)} restartKey={orbState} />
      <span className="island__label">{companion?.state === 'unknown' ? '? ' : companion?.state === 'disconnected' ? '− ' : ''}{collapsedLabel}</span>
      {ui.activeRisk && working && !replaying ? <i data-presence={companion?.state} className="island__dot island__dot--warning" /> : <i data-presence={companion?.state} className={`island__dot island__dot--${dotClass}`} />}
    </>} heading={<>
        <MiniOrb companion={companion} size={16} glow={0.3 + orb.glowCool * 0.6} warm={orb.glowWarm} />
        <span className="island__title" title={project || undefined}>{project || 'Raio'}</span>
    </>} status={<AgentStatus state={ui.status} agent={script.agent} companion={companion} />}>
      <div className={`island__task${ready ? ' island__task--muted' : ''}`} title={lastActivity}>{replaying ? `${agentFull} · Replay` : observations ? lastActivity : `${agentFull} · ${lastActivity}`}</div>
      <div className="island__hint island__reason" title={description}>{companion?.state === 'failure' || companion?.state === 'attention' || companion?.state === 'unknown' ? companion.description : recentActivity ? presence.activeNodeLabel ? `Last in ${presence.activeNodeLabel}` : 'Recent observed activity' : lastActivity}</div>
      <div className="island__row island__row--actions">
        <span className="island__spacer" />
        <IconButton label="Open Mini Player" onClick={onPinMini}>
          <PictureInPictureIcon />
        </IconButton>
        <IconButton label="Open full view" onClick={onExpand}>
          <ExpandIcon />
        </IconButton>
      </div>
    </IslandShell>
  );
};
