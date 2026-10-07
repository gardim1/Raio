import { useEffect, useMemo } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { Surface } from '../../platform/desktopBridge';
import { receptionProblem } from '../../platform/coreHealth';
import { IconButton } from '../../shared/ui/Button';
import { CollapseIcon, PinIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import { IdleIsland } from '../modes/IdleIsland';
import { expandedWindowChrome } from '../modes/ExpandedWindow';
import { MiniSurface } from '../modes/MiniSurface';
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
  const heading = snapshot.listing === 'pending' ? 'Mapping project' : snapshot.listing === 'unavailable' ? 'Project listing unavailable' : `${snapshot.graph.nodes.length} ${snapshot.graph.nodes.length === 1 ? 'system' : 'systems'} mapped`;
  const problem = receptionProblem(snapshot.core, snapshot.provenance === 'fixture');
  const waiting = problem ?? 'Waiting for an agent session';
  const go = (surface: Surface) => bridge.showSurface(surface);
  if (mode === 'island') return <IdleIsland onOpen={() => go('expanded')} />;
  if (mode === 'mini') return (
    <MiniSurface project={snapshot.project.name} projectTitle="No session recorded yet" status="ready" stateLabel="No session yet" pinned={pinned}
      onTogglePin={() => { bridge.setPinned(!pinned); togglePin(); }} onExpand={() => go('expanded')} onCollapse={() => go('island')}
      footer={<div className="mini__foot"><span className="mini__foot-text" title={waiting} style={problem ? { overflow: 'hidden', textOverflow: 'ellipsis' } : undefined}>{problem ?? (snapshot.listing === 'ready' ? waiting : heading)}</span></div>}>
      <ArchitectureCanvas graph={snapshot.graph} frame={frame} variant="mini" camera={false} fit={snapshot.graph.nodes.length > 0 ? 'content' : 'world'} className="mini__svg" label="Project architecture map" />
    </MiniSurface>
  );
  const nativeWindow = expandedWindowChrome(bridge, typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return (
    <div className="expanded-dock">
      <div className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar nativeWindow={nativeWindow} project={snapshot.project.name} agent="unknown" task={waiting} taskVisible taskIsPlaceholder taskPrefix="Connected ·" status="ready" statusLabel="No session yet" actions={<>
          <IconButton label="Pin as mini player" onClick={() => go('mini')}><PinIcon /></IconButton>
          <IconButton label="Tuck into Island" onClick={() => go('island')}><CollapseIcon /></IconButton>
        </>} />
        <div className="expanded__body">
          <div className="map expanded__map"><ArchitectureCanvas graph={snapshot.graph} frame={frame} className="map__svg" label="Project architecture map" /></div>
          <aside className="sidebar"><div className="sidebar__scroll">
            <div className="sidebar__overview"><div className="sidebar__eyebrowless">{snapshot.project.name}</div><div className="sidebar__task">{heading}</div><div className="sidebar__meta">{waiting}</div></div>
            <p className="evidence__note">No session recorded yet</p>
            <p className="evidence__note">{snapshot.note}</p>
            {snapshot.technologies.length > 0 && <ul className="evidence__list" aria-label="Technologies">{snapshot.technologies.map((line) => <li key={line} className="evidence__item"><span className="evidence__path" title={line}>{line}</span><span className="evidence__meta">named in manifests (names only, heuristic)</span></li>)}</ul>}
            {bridge.connector && <ConnectionFooter connector={bridge.connector} />}
          </div></aside>
        </div>
        <div className="footer"><div className="footer__left"><div className="hint">{waiting}</div></div></div>
      </div>
    </div>
  );
};
