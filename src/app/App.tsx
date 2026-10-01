import { LayoutGroup } from 'motion/react';
import { useEffect, useMemo } from 'react';
import { demoGraph } from '../features/architecture/model/demoProject';
import { StatesGallery } from '../features/gallery/StatesGallery';
import { DesktopBackdrop } from '../features/modes/DesktopBackdrop';
import { ExpandedWindow } from '../features/modes/ExpandedWindow';
import { IslandMode } from '../features/modes/IslandMode';
import { MiniPlayer } from '../features/modes/MiniPlayer';
import { derivePresence } from '../features/modes/presence';
import { ReplayControls } from '../features/modes/ReplayControls';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { compileReplay } from '../features/session/model/compileReplay';
import { demoSessionLog } from '../features/session/model/demoSession';
import { evaluateFrame } from '../features/session/model/evaluateFrame';
import { deriveInsights } from '../features/session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../features/session/model/script';
import { type DisplayMode, useSessionUi } from '../features/session/store/sessionStore';
import { usePlayback } from '../shared/motion/usePlayback';
import { FilmMode } from './FilmMode';
import { MODES, ModeDock } from './ModeDock';

const PROJECT = demoSessionLog.project;

/** The live surfaces use the canonical choreography without the film-only wordmark. */
const liveScript: ChoreographyScript = (() => {
  const { wordmarkAt, ...rest } = canonicalScript;
  void wordmarkAt;
  return { ...rest, id: 'live-demo' };
})();

/** Prototype shell: one simulated live session, one compiled replay, three display modes. */
export const App = () => {
  const { mode, source, selectedNodeId, pinned, liveRun, replayRun, setMode, startReplay, exitReplay, selectNode, togglePin, restartLive } = useSessionUi();
  const replayScript = useMemo(() => compileReplay(demoSessionLog, demoGraph), []);
  const insights = useMemo(() => deriveInsights(demoSessionLog), []);

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
      const m = MODES.find((x) => x.key === e.key);
      if (m) setMode(m.id as DisplayMode);
      if (e.key === ' ' && source === 'replay') {
        e.preventDefault();
        replay.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode, source, replay]);

  const isReplay = source === 'replay';
  const script = isReplay ? replayScript : liveScript;
  const t = isReplay ? replay.t : live.t;
  const frame = evaluateFrame(script, demoGraph, t);
  const presence = derivePresence(script, demoGraph, frame, isReplay);

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

  const appMode = mode === 'island' || mode === 'mini' || mode === 'expanded';

  return (
    <div className={`app app--${mode}`}>
      {mode === 'film' && <FilmMode />}
      {mode === 'states' && <StatesGallery />}
      {appMode && (
        <>
          <DesktopBackdrop />
          <LayoutGroup>
            {mode === 'island' && (
              <IslandMode script={script} frame={frame} presence={presence} onPinMini={() => setMode('mini')} onExpand={() => setMode('expanded')} onViewChanges={startReplay} />
            )}
            {mode === 'mini' && (
              <MiniPlayer
                script={script}
                frame={frame}
                graph={demoGraph}
                project={PROJECT}
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
                graph={demoGraph}
                project={PROJECT}
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
        </>
      )}
      <ModeDock mode={mode} onMode={setMode} onRunLive={restartLive} onViewChanges={startReplay} />
    </div>
  );
};
