import { IslandShell } from './IslandShell';
import { agentFullName, agentShortName } from '../../shared/ui/agentName';
import { useBridge, useSessionSnapshot } from '../../platform/BridgeContext';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { islandActivity, islandCaption, islandObservedActivity } from './islandActivity';
import { MiniOrb } from '../raio/MiniOrb';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { useSessionUi } from '../session/store/sessionStore';
import { islandOrbBobs, islandOrbState } from './islandOrbState';
import type { Presence } from './presence';
import { deriveCompanionPresence, type CompanionPresence } from './companionPresence';
import { fallbackPresenceInput } from './presenceClock';
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
  const effective = companion ?? deriveCompanionPresence(observations ?? fallbackPresenceInput(snapshot, null, bridge.kind === 'fixture'), Date.now());
  const lastActivity = observations
    ? islandObservedActivity(observations.facts, Date.now())
    : `Last replay event · ${islandActivity(snapshot?.log ?? null)} · ${snapshot?.provenance === 'fixture' ? 'Demo fixture' : 'Recorded session log'}`;
  const replaying = useSessionUi((s) => s.source === 'replay');
  const agent = agentShortName(script.agent);
  const agentFull = agentFullName(script.agent);
  const working = ui.status === 'working';
  const finished = ui.finished;
  const collapsedLabel = replaying ? 'Replaying' : islandCaption(effective, presence.activeNodeLabel, agent);
  const description = !replaying && collapsedLabel === `${agent} · ${presence.activeNodeLabel}`
    ? `${collapsedLabel} · ${effective.description}` : effective.description;
  const warning = effective.state === 'failure' || effective.state === 'attention' || effective.state === 'unknown';
  const activity = warning ? `${effective.description} · Latest: ${lastActivity}`
    : effective.state === 'connected' ? `No agent active right now. · ${lastActivity}`
      : lastActivity;
  const orbState = islandOrbState({ working, replaying, recentlyFinished: presence.recentlyFinished, finished });

  return (
    <IslandShell description={description} collapsed={<>
      <span className="island__character" title={`${project || 'Raio'} · ${agentFull}`}>
        <MiniOrb companion={effective} size={14} glow={0.25 + orb.glowCool * 0.6} warm={orb.glowWarm} bob={islandOrbBobs(orbState)} restartKey={orbState} />
      </span>
      <span className="island__label">{effective.state === 'unknown' ? '? ' : effective.state === 'disconnected' ? '− ' : ''}{collapsedLabel}</span>
      <i data-presence={effective.state} className="island__dot" />
    </>}>
      <p className="island__activity" title={activity}>{activity}</p>
      <div className="island__actions">
        <button type="button" title="Open Mini Player" aria-label="Open Mini Player" onClick={onPinMini}>Open Mini Player</button>
        <button type="button" title="Open window" aria-label="Open window" onClick={onExpand}>Open window</button>
      </div>
    </IslandShell>
  );
};
