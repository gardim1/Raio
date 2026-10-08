import { IslandShell } from './IslandShell';
import { agentFullName, agentShortName } from '../../shared/ui/agentName';
import { useBridge, useSessionSnapshot } from '../../platform/BridgeContext';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { islandActivity, islandCaption, islandObservedActivity } from './islandActivity';
import { IslandCharacter } from './IslandCharacter';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { useSessionUi } from '../session/store/sessionStore';
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
export const IslandMode = ({ script, presence, companion, onPinMini, onExpand }: IslandModeProps) => {
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
  const collapsedLabel = replaying ? 'Replaying' : islandCaption(effective, presence.activeNodeLabel, agent);
  const description = !replaying && collapsedLabel === `${agent} · ${presence.activeNodeLabel}`
    ? `${collapsedLabel} · ${effective.description}` : effective.description;
  const warning = effective.state === 'failure' || effective.state === 'attention' || effective.state === 'unknown';
  const activity = warning ? `${effective.description} · Latest: ${lastActivity}`
    : effective.state === 'connected' ? `No agent active right now. · ${lastActivity}`
      : lastActivity;

  return (
    <IslandShell description={description} onPinMini={onPinMini} onExpand={onExpand} collapsed={<>
      <IslandCharacter companion={effective} title={`${project || 'Raio'} · ${agentFull}`} />
      <span className="island__label">{effective.state === 'unknown' ? '? ' : effective.state === 'disconnected' ? '− ' : ''}{collapsedLabel}</span>
      <i data-presence={effective.state} className="island__dot" />
    </>}>
      <p className="island__activity" title={activity}>{activity}</p>
    </IslandShell>
  );
};
