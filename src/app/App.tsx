import { LayoutGroup } from 'motion/react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { ExpandedWindow } from '../features/modes/ExpandedWindow';
import { IslandMode } from '../features/modes/IslandMode';
import { MiniPlayer } from '../features/modes/MiniPlayer';
import { derivePresence } from '../features/modes/presence';
import { ReplayControls } from '../features/modes/ReplayControls';
import { NoProjectState } from '../features/panel/NoProjectState';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { compileReplay } from '../features/session/model/compileReplay';
import { evaluateFrame } from '../features/session/model/evaluateFrame';
import { deriveInsights } from '../features/session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../features/session/model/script';
import { useSessionUi } from '../features/session/store/sessionStore';
import { useSessionSnapshot } from '../platform/BridgeContext';
import type { SessionSnapshot } from '../platform/desktopBridge';
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
  const mode = useSessionUi((s) => s.mode);
  return (
    <div className={`app app--${mode}`}>
      {underlay}
      {snapshot ? (
        <Surfaces snapshot={snapshot} />
      ) : (
        <div className="app__empty">
          <NoProjectState />
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
  const { mode, source, selectedNodeId, pinned, liveRun, replayRun, setMode, startReplay, exitReplay, selectNode, togglePin } = useSessionUi();
  const replayScript = useMemo(() => compileReplay(log, graph), [log, graph]);
  const insights = useMemo(() => deriveInsights(log), [log]);

  const live = usePlayback({ reducedMotionAt: 30 });
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
  const script = isReplay ? replayScript : liveScript;
  const t = isReplay ? replay.t : live.t;
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
          if (compact && ev.nodeId) setMode('expanded');
        }}
        onExit={exitReplay}
      />
    ) : undefined;

  return (
    <LayoutGroup>
      {mode === 'island' && (
        <IslandMode script={script} frame={frame} presence={presence} onPinMini={() => setMode('mini')} onExpand={() => setMode('expanded')} onViewChanges={startReplay} />
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
          onTogglePin={togglePin}
          onExpand={() => setMode('expanded')}
          onCollapse={() => setMode('island')}
          onViewChanges={startReplay}
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
          onPinMini={() => setMode('mini')}
          onIsland={() => setMode('island')}
          onViewChanges={startReplay}
        />
      )}
    </LayoutGroup>
  );
};
