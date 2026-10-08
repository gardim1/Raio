import { useBridge, useProjectMapSnapshot } from '../../platform/BridgeContext';
import type { CompanionPresence } from './companionPresence';
import { IslandCharacter } from './IslandCharacter';
import { IslandShell } from './IslandShell';
import { islandCaption, islandPresenceActivity } from './islandActivity';

/** Compatible with existing no-session call sites; only explicit preview actions change surfaces. */
export const IdleIsland = ({ onOpen, companion }: { readonly onOpen: () => void; readonly companion?: CompanionPresence }) => {
  const bridge = useBridge();
  const map = useProjectMapSnapshot();
  const project = bridge.connector?.project()?.name ?? map?.project.name;
  const disconnected = companion ? companion.state === 'disconnected' : !project;
  const label = companion ? islandCaption(companion) : disconnected ? 'Disconnected · no project' : 'Waiting';
  const description = companion?.description ?? (disconnected ? label : 'Connected · quiet');
  const observed = companion?.state === 'working' ? `Agent unknown · ${islandPresenceActivity(bridge.projectPresence?.().facts ?? [], Date.now())}` : null;
  const message = disconnected ? 'Choose a project to connect' : companion?.state === 'unknown'
    ? 'Activity status unavailable' : companion?.state === 'failure' || companion?.state === 'attention'
      ? description : observed ? `Recent observed activity · ${observed}` : 'No agent active right now.';
  return <IslandShell description={description} onPinMini={() => bridge.showSurface('mini')} onExpand={onOpen} collapsed={<>
    <IslandCharacter companion={companion} title={project} />
    <span className="island__label">{companion?.state === 'unknown' ? '? ' : disconnected ? '− ' : ''}{label}</span>
    <i data-presence={companion?.state} className="island__dot" />
  </>}>
    <p className="island__activity" title={message}>{message}</p>
  </IslandShell>;
};
