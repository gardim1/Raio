import { useBridge, useProjectMapSnapshot } from '../../platform/BridgeContext';
import { Button, IconButton } from '../../shared/ui/Button';
import { ExpandIcon, PictureInPictureIcon } from '../../shared/ui/icons';
import type { CompanionPresence } from './companionPresence';
import { MiniOrb } from '../raio/MiniOrb';
import { IslandShell } from './IslandShell';
import { islandPresenceActivity } from './islandActivity';

/** Compatible with existing no-session call sites; only explicit preview actions change surfaces. */
export const IdleIsland = ({ onOpen, companion }: { readonly onOpen: () => void; readonly companion?: CompanionPresence }) => {
  const bridge = useBridge();
  const map = useProjectMapSnapshot();
  const project = bridge.connector?.project()?.name ?? map?.project.name;
  const disconnected = companion ? companion.state === 'disconnected' : !project;
  const label = companion?.label ?? (disconnected ? 'Disconnected · no project' : 'Connected · quiet');
  const description = companion?.description ?? label;
  const observed = companion?.state === 'working' ? `Agent unknown · ${islandPresenceActivity(bridge.projectPresence?.().facts ?? [], Date.now())}` : null;
  const message = disconnected ? 'Choose a project to connect' : companion?.state === 'unknown'
    ? 'Activity status unavailable' : companion?.state === 'failure' || companion?.state === 'attention'
      ? label : observed ? 'Recent observed activity' : 'Waiting for activity';
  return <IslandShell description={description} collapsed={<>
    <MiniOrb companion={companion} size={14} glow={0.25} />
    <span className="island__label">{companion?.state === 'unknown' ? '? ' : disconnected ? '− ' : ''}{label}</span>
    <i data-presence={companion?.state} className="island__dot island__dot--idle" />
  </>} heading={<><MiniOrb companion={companion} size={16} glow={0.3} /><span className="island__title" title={project}>{project ?? 'Raio'}</span></>}>
    <div className="island__task" title={message}>{message}</div>
    <div className="island__hint island__reason" title={observed ?? description}>{disconnected ? 'Connect a folder to observe Claude Code activity' : observed ?? (companion?.state === 'attention' || companion?.state === 'failure' || companion?.state === 'unknown' ? description : 'Start a new Claude Code session in this folder')}</div>
    <div className="island__row island__row--actions">
      {disconnected && <Button onClick={onOpen}>Choose a project</Button>}
      <span className="island__spacer" />
      <IconButton label="Open Mini Player" onClick={() => bridge.showSurface('mini')}><PictureInPictureIcon /></IconButton>
      <IconButton label="Open full view" onClick={onOpen}><ExpandIcon /></IconButton>
    </div>
  </IslandShell>;
};
