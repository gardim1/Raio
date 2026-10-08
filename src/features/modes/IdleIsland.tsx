import { useBridge, useProjectMapSnapshot } from '../../platform/BridgeContext';
import type { CompanionPresence } from './companionPresence';
import { MiniOrb } from '../raio/MiniOrb';
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
  return <IslandShell description={description} collapsed={<>
    <span className="island__character" title={project}><MiniOrb companion={companion} size={14} glow={0.25} /></span>
    <span className="island__label">{companion?.state === 'unknown' ? '? ' : disconnected ? '− ' : ''}{label}</span>
    <i data-presence={companion?.state} className="island__dot" />
  </>}>
    <p className="island__activity" title={message}>{message}</p>
    <div className="island__actions">
      <button type="button" title="Open Mini Player" aria-label="Open Mini Player" onClick={() => bridge.showSurface('mini')}>Open Mini Player</button>
      <button type="button" title="Open window" aria-label="Open window" onClick={onOpen}>Open window</button>
    </div>
  </IslandShell>;
};
