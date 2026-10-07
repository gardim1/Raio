import { useEffect, useMemo } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { Surface } from '../../platform/desktopBridge';
import { IconButton } from '../../shared/ui/Button';
import { CollapseIcon, ExpandIcon, PinIcon } from '../../shared/ui/icons';
import { tokens } from '../../tokens';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import { IdleIsland } from '../modes/IdleIsland';
import { ConnectionFooter } from '../panel/ConnectionFooter';
import { TitleBar } from '../panel/TitleBar';
import { useSessionUi } from '../session/store/sessionStore';
import type { ProjectMapSnapshot } from './projectMap';
import { projectMapFrame } from './projectMapFrame';

/** The connected repository before telemetry. No session model, clock, timeline or replay is constructed. */
export const ProjectOnlyView = ({ snapshot, mode }: { readonly snapshot: ProjectMapSnapshot; readonly mode: Surface }) => {
  const bridge = useBridge();
  const { pinned, togglePin, exitReplay } = useSessionUi();
  const frame = useMemo(() => projectMapFrame(snapshot.graph), [snapshot.graph]);
  useEffect(() => exitReplay(), [snapshot.project.id, exitReplay]);
  const heading = snapshot.listing === 'pending' ? 'Mapping project' : snapshot.listing === 'unavailable' ? 'Project listing unavailable' : `${snapshot.graph.nodes.length} areas mapped`;
  const go = (surface: Surface) => bridge.showSurface(surface);
  if (mode === 'island') return <IdleIsland onOpen={() => go('expanded')} />;
  if (mode === 'mini') return (
    <div className="mini" style={{ width: tokens.size.miniPlayer.width, height: tokens.size.miniPlayer.height, right: 28, bottom: 104, borderRadius: 20 }}>
      <header className="mini__head">
        <span className="mini__status mini__status--ready" />
        <span className="mini__project">{snapshot.project.name}</span>
        <span className="mini__state">No session yet</span>
        <span className="mini__spacer" />
        <IconButton label={pinned ? 'Unpin (stop floating on top)' : 'Keep on top'} active={pinned} onClick={() => { bridge.setPinned(!pinned); togglePin(); }}><PinIcon filled={pinned} /></IconButton>
        <IconButton label="Tuck into Island" onClick={() => go('island')}><CollapseIcon /></IconButton>
        <IconButton label="Open full view" onClick={() => go('expanded')}><ExpandIcon /></IconButton>
      </header>
      <div className="mini__map">
        <ArchitectureCanvas graph={snapshot.graph} frame={frame} variant="mini" camera={false} fit={snapshot.graph.nodes.length > 0 ? 'content' : 'world'} className="mini__svg" label="Project architecture map" />
      </div>
      <div className="mini__foot"><span className="mini__foot-text">{snapshot.listing === 'ready' ? 'Waiting for an agent session' : heading}</span></div>
    </div>
  );
  return (
    <div className="expanded-dock">
      <div className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar project={snapshot.project.name} agent="unknown" task="Waiting for an agent session" taskVisible taskIsPlaceholder taskPrefix="Connected ·" status="ready" statusLabel="No session yet" actions={<>
          <IconButton label="Pin as mini player" onClick={() => go('mini')}><PinIcon /></IconButton>
          <IconButton label="Tuck into Island" onClick={() => go('island')}><CollapseIcon /></IconButton>
        </>} />
        <div className="expanded__body">
          <div className="map expanded__map"><ArchitectureCanvas graph={snapshot.graph} frame={frame} className="map__svg" label="Project architecture map" /></div>
          <aside className="sidebar"><div className="sidebar__scroll">
            <div className="sidebar__overview"><div className="sidebar__eyebrowless">{snapshot.project.name}</div><div className="sidebar__task">{heading}</div><div className="sidebar__meta">Waiting for an agent session</div></div>
            <p className="evidence__note">{snapshot.note}</p>
            {snapshot.technologies.length > 0 && <ul className="evidence__list" aria-label="Technologies">{snapshot.technologies.map((line) => <li key={line} className="evidence__item"><span className="evidence__path" title={line}>{line}</span><span className="evidence__meta">named in manifests (names only, heuristic)</span></li>)}</ul>}
            {bridge.connector && <ConnectionFooter connector={bridge.connector} />}
          </div></aside>
        </div>
        <div className="footer"><div className="footer__left"><div className="hint">Waiting for an agent session</div></div></div>
      </div>
    </div>
  );
};
