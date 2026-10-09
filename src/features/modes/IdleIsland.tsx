import { useBridge, useProjectMapSnapshot } from '../../platform/BridgeContext';
import type { CompanionPresence } from './companionPresence';
import { IslandCharacter } from './IslandCharacter';
import { IslandShell } from './IslandShell';
import { islandCaption, islandPreviewActivity } from './islandActivity';
import { deriveCompanionPresence } from './companionPresence';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { integrationIndicator } from '../panel/sidebarState';
import { readIntegrationStatus } from '../../platform/desktopBridge';

/** Compatible with existing no-session call sites; only explicit preview actions change surfaces. */
export const IdleIsland = ({ onOpen, companion }: { readonly onOpen: () => void; readonly companion?: CompanionPresence }) => {
  const bridge = useBridge();
  const map = useProjectMapSnapshot();
  const project = bridge.connector?.project()?.name ?? map?.project.name;
  const observations = useSurfaceStore(bridge.subscribe, () => bridge.projectPresence?.() ?? null);
  const integration = useSurfaceStore(bridge.subscribe, () => readIntegrationStatus(bridge));
  const effective = companion ?? deriveCompanionPresence(observations ?? { connected:!!project, available:true, facts:[] }, Date.now());
  const disconnected = effective.state === 'disconnected';
  const label = islandCaption(effective);
  const description = effective.description;
  const activity = islandPreviewActivity(effective, observations?.facts ?? [], Date.now());
  const status = effective.state === 'disconnected' || observations?.available === false
    ? null : integrationIndicator(integration, observations ?? undefined, Date.now());
  return <IslandShell description={description} onPinMini={() => bridge.showSurface('mini')} onExpand={onOpen} collapsed={<>
    <IslandCharacter companion={effective} title={project} />
    <span className="island__heading"><span className="island__identity" title={project}>{project || 'Raio'} · {disconnected ? 'No project' : 'Agent unknown'}</span>
      <span className="island__label">{effective.state === 'unknown' ? '? ' : disconnected ? '− ' : ''}{label}</span></span>
    <i data-presence={effective.state} className="island__dot" />
  </>}>
    <p className="island__activity" title={activity}>{activity}</p>
    {status && status !== activity && <p className="island__integration" title={status}>{status}</p>}
  </IslandShell>;
};
