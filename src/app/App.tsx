import { LayoutGroup } from 'motion/react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { ExpandedWindow } from '../features/modes/ExpandedWindow';
import { IslandMode } from '../features/modes/IslandMode';
import { MiniPlayer } from '../features/modes/MiniPlayer';
import { CTA_PROMINENT_SECONDS, derivePresence } from '../features/modes/presence';
import { ReplayControls } from '../features/modes/ReplayControls';
import { ConnectPanel } from '../features/panel/ConnectPanel';
import { NoProjectState } from '../features/panel/NoProjectState';
import { IdleIsland } from '../features/modes/IdleIsland';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { compileReplay } from '../features/session/model/compileReplay';
import { evaluateFrame } from '../features/session/model/evaluateFrame';
import { deriveInsights } from '../features/session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../features/session/model/script';
import { useSessionUi } from '../features/session/store/sessionStore';
import { useBridge, useSessionSnapshot } from '../platform/BridgeContext';
import { NativeSurfaceEffects } from '../platform/NativeSurfaceEffects';
import type { SessionSnapshot, Surface } from '../platform/desktopBridge';
import { usePlayback } from '../shared/motion/usePlayback';

/** The live surfaces use the canonical choreography without the film-only wordmark. */
const liveScript: ChoreographyScript = (() => {
  const { wordmarkAt, ...rest } = canonicalScript;
  void wordmarkAt;
  return { ...rest, id: 'live-demo' };
})();

export interface AppProps {
  /** Optional layer drawn between the background and the surfaces (used by the dev harness). */
  readonly underlay?: ReactNode;
}

/** The Raio product: Island, Mini Player and Expanded surfaces fed by the desktop bridge. */
export const App = ({ underlay }: AppProps) => {
  const snapshot = useSessionSnapshot();
  const bridge = useBridge();
  const storeMode = useSessionUi((s) => s.mode);
  const mode = bridge.fixedSurface ?? storeMode;
  return (
    <div className={`app app--${mode}`}>
      {bridge.kind === 'native' && <NativeSurfaceEffects />}
      {underlay}
      {snapshot ? (
        <Surfaces snapshot={snapshot} />
      ) : (
        <div className="app__empty">
          {bridge.connector && mode === 'expanded' ? (
            <ConnectPanel connector={bridge.connector} />
          ) : bridge.connector && mode === 'island' ? (
            <IdleIsland onOpen={() => bridge.showSurface('expanded')} />
          ) : bridge.connector ? (
            <p className="app__empty-note">No session yet</p>
          ) : (
            <NoProjectState />
          )}
        </div>
      )}
      {snapshot?.provenance === 'fixture' && (
        <div className="app__fixture-badge" role="note">
          Demo fixture · not real agent activity
        </div>
      )}
    </div>
  );
};

const Surfaces = ({ snapshot }: { readonly snapshot: SessionSnapshot }) => {
  const { graph, log, project } = snapshot;
  const bridge = useBridge();
  const { mode: storeMode, source, selectedNodeId, pinned, liveRun, replayRun, startReplay, exitReplay, selectNode, togglePin } = useSessionUi();
  const mode = bridge.fixedSurface ?? storeMode;
  /** Browser: switch in place. Native: show that surface's window (and hide this one). */
  const go = (surface: Surface) => bridge.showSurface(surface);
  /** "View changes": native Island hands the replay to the Mini Player window; elsewhere it plays in place. */
  const viewChanges = () => (bridge.kind === 'native' && mode === 'island' ? bridge.showSurface('mini', 'replay') : startReplay());
  const onTogglePin = () => {
    bridge.setPinned(!pinned);
    togglePin();
  };
  const replayScript = useMemo(() => compileReplay(log, graph), [log, graph]);
  const insights = useMemo(() => deriveInsights(log), [log]);

  // The live demo clock follows wall time and stops once the completion offer has gone quiet.
  const live = usePlayback({ reducedMotionAt: 30, wallClock: true, stopAt: liveScript.summary.detailAt + CTA_PROMINENT_SECONDS + 2 });
  const replay = usePlayback({ stopAt: replayScript.duration + 0.6, autoplay: false });

  useEffect(() => {
    if (liveRun > 0) live.restart();
  }, [liveRun]);
  useEffect(() => {
    if (replayRun > 0) replay.restart();
  }, [replayRun]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (e.key === ' ' && source === 'replay') {
        e.preventDefault();
        replay.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, replay]);

  const isReplay = source === 'replay';
  // Live agent data has no animated director yet (E2E-1): the live surfaces show the session's
  // compiled state at its end, recomputed whenever new events arrive. The demo fixture keeps its film.
  const liveData = snapshot.provenance === 'live';
  const script = isReplay || liveData ? replayScript : liveScript;
  const t = isReplay ? replay.t : liveData ? replayScript.duration + CTA_PROMINENT_SECONDS + 2 : live.t;
  const frame = evaluateFrame(script, graph, t);
  const presence = derivePresence(script, graph, frame, isReplay);

  const onSelectEvent = (ev: StoryEvent) => {
    if (ev.nodeId) selectNode(ev.nodeId);
    if (isReplay) replay.seek(ev.t);
  };

  const replayControls = (compact: boolean) =>
    isReplay ? (
      <ReplayControls
        script={replayScript}
        playback={replay}
        compact={compact}
        onInspect={(ev) => {
          if (ev.nodeId) selectNode(ev.nodeId);
          if (compact && ev.nodeId) go('expanded');
        }}
        onExit={exitReplay}
      />
    ) : undefined;

  return (
    <LayoutGroup>
      {mode === 'island' && (
        <IslandMode script={script} frame={frame} presence={presence} onPinMini={() => go('mini')} onExpand={() => go('expanded')} onViewChanges={viewChanges} />
      )}
      {mode === 'mini' && (
        <MiniPlayer
          script={script}
          frame={frame}
          graph={graph}
          project={project}
          presence={presence}
          pinned={pinned}
          replay={replayControls(true)}
          {...(isReplay ? { stateLabel: frame.ui.finished ? 'Replay complete' : 'Replay' } : {})}
          onTogglePin={onTogglePin}
          onExpand={() => go('expanded')}
          onCollapse={() => go('island')}
          onViewChanges={viewChanges}
        />
      )}
      {mode === 'expanded' && (
        <ExpandedWindow
          script={script}
          frame={frame}
          graph={graph}
          project={project}
          insights={insights}
          presence={presence}
          selectedNodeId={selectedNodeId}
          replay={replayControls(false)}
          isReplay={isReplay}
          onSelectNode={selectNode}
          onSelectEvent={onSelectEvent}
          onPinMini={() => go('mini')}
          onIsland={() => go('island')}
          onViewChanges={viewChanges}
        />
      )}
    </LayoutGroup>
  );
};
