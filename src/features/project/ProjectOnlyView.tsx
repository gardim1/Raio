import { useEffect, useMemo } from 'react';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import type { CompanionPresence } from '../modes/companionPresence';
import { PresenceHistory } from '../modes/PresenceHistory';
import { useBridge } from '../../platform/BridgeContext';
import { readIntegrationStatus, type Surface } from '../../platform/desktopBridge';
import { IconButton } from '../../shared/ui/Button';
import { IslandIcon, PictureInPictureIcon } from '../../shared/ui/icons';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import { IdleIsland } from '../modes/IdleIsland';
import { expandedWindowChrome } from '../modes/ExpandedWindow';
import { MiniSurface } from '../modes/MiniSurface';
import { ConnectionFooter } from '../panel/ConnectionFooter';
import { AboutMap } from '../panel/AboutMap';
import { ConnectPanel } from '../panel/ConnectPanel';
import { NoProjectState } from '../panel/NoProjectState';
import { deriveSidebarState } from '../panel/sidebarState';
import { TitleBar } from '../panel/TitleBar';
import { useSessionUi } from '../session/store/sessionStore';
import type { ProjectMapSnapshot } from './projectMap';
import { projectMapFrame } from './projectMapFrame';
import { ExpandedCompanionActions } from '../raio/ExpandedCompanionActions';

/** The connected repository before telemetry. No session model, clock, timeline or replay is constructed. */
export const ProjectOnlyView = ({ snapshot, mode, companion }: { readonly snapshot: ProjectMapSnapshot; readonly mode: Surface; readonly companion?: CompanionPresence }) => {
  const bridge = useBridge();
  const { pinned, togglePin, exitReplay } = useSurfaceStore(useSessionUi.subscribe, useSessionUi.getState);
  const frame = useMemo(() => projectMapFrame(snapshot.graph), [snapshot.graph]);
  useEffect(() => exitReplay(), [snapshot.project.id, exitReplay]);
  const connection = useSurfaceStore(bridge.subscribe, () => bridge.connector?.project() ?? null);
  const hooks = useSurfaceStore(bridge.subscribe, () => bridge.projectHooksState?.() ?? 'unknown');
  const presence = useSurfaceStore(bridge.subscribe, () => bridge.projectPresence?.());
  const integration = useSurfaceStore(bridge.subscribe, () => readIntegrationStatus(bridge));
  const state = deriveSidebarState({ snapshot, connected: bridge.connector ? connection !== null : true, hooks, presence, integration });
  const helperMissing = integration?.hooks === 'current' && !integration.hookBinary;
  const nativeWindow = useMemo(() => expandedWindowChrome(bridge, typeof navigator === 'undefined' ? '' : navigator.userAgent), [bridge]);
  const go = (surface: Surface) => bridge.showSurface(surface);
  if (mode === 'island') return <IdleIsland companion={companion} onOpen={() => go('expanded')} />;
  if (state.action === 'connect') return bridge.connector ? <ConnectPanel connector={bridge.connector} /> : <NoProjectState />;
  if (mode === 'mini') return (
    <MiniSurface companion={companion} project={snapshot.project.name} projectTitle={snapshot.project.name} status="ready" stateLabel="No session yet" pinned={pinned}
      onTogglePin={() => { bridge.setPinned(!pinned); togglePin(); }} onExpand={() => go('expanded')} onCollapse={() => go('island')}
      footer={<div className="mini__foot"><span className="mini__foot-text" title={[state.heading, ...state.warnings].join(' · ')} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{state.warnings[0] ?? state.heading}</span></div>}>
      <ArchitectureCanvas graph={snapshot.graph} frame={frame} variant="mini" camera={false} fit={snapshot.graph.nodes.length > 0 ? 'content' : 'world'} className="mini__svg" label="Project architecture map" />
    </MiniSurface>
  );
  return (
    <div className="expanded-dock">
      <div className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar companion={companion} nativeWindow={nativeWindow} project={snapshot.project.name} agent="unknown" task="Project overview" taskVisible taskIsPlaceholder taskPrefix="Connected ·" status="ready" statusLabel="No session yet" actions={<>
          <ExpandedCompanionActions />
          <IconButton label="Open Mini Player" onClick={() => go('mini')}><PictureInPictureIcon /></IconButton>
          <IconButton label="Show as Island" onClick={() => go('island')}><IslandIcon /></IconButton>
        </>} />
        <div className="expanded__body">
          <div className="map expanded__map"><ArchitectureCanvas graph={snapshot.graph} frame={frame} className="map__svg" label="Project architecture map" /></div>
          <aside className="sidebar"><div className="sidebar__scroll">
            <div className="sidebar__overview">
              <div className="sidebar__eyebrowless" role="heading" aria-level={2} title={state.projectName} aria-label={state.projectName}>{state.projectName}</div>
              <div className="sidebar__task">{state.heading}</div>
              <div className="sidebar__meta" {...(helperMissing ? { role: 'status', 'aria-label': state.indicator } : {})}>{state.indicator}</div>
            </div>
            <p className="evidence__note">{state.areaCount} · heuristic map</p>
            {state.message && <p className="sidebar__hint">{state.message}</p>}
            {state.warnings.map(line => <p className="evidence__warn" role="status" aria-label={line} key={line}>{line}</p>)}
            {companion && <PresenceHistory presence={companion} />}
            {state.action === 'choose-another' && bridge.connector && <ConnectPanel key={JSON.stringify([connection?.id, connection?.root])} connector={bridge.connector} chooseAnother />}
            <AboutMap details={state.details} technologies={snapshot.technologies} />
            {bridge.connector && <ConnectionFooter connector={bridge.connector} />}
          </div></aside>
        </div>
        <div className="footer"><div className="footer__left"><div className="hint">Project map</div></div></div>
      </div>
    </div>
  );
};
