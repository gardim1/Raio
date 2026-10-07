import { LayoutGroup } from 'motion/react';
import { Activity, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useCompanionPresence } from '../features/modes/presenceClock';
import type { CompanionPresence } from '../features/modes/companionPresence';
import { useSurfaceVisible } from '../shared/motion/surfaceVisibility';
import { useSurfaceStore } from '../shared/motion/visibleStore';
import { TitleBar, type TitleBarWindowApi } from '../features/panel/TitleBar';
import { ExpandedWindow, expandedWindowChrome } from '../features/modes/ExpandedWindow';
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
import { useLiveFollow } from '../features/session/live/useLiveFollow';
import { trackReplayActivity, type ReplayActivityState } from '../features/session/live/replayActivity';
import { deriveInsights } from '../features/session/model/insights';
import type { ChoreographyScript, StoryEvent } from '../features/session/model/script';
import { useSessionUi } from '../features/session/store/sessionStore';
import { useBridge, useProjectMapSnapshot, useSessionSnapshot } from '../platform/BridgeContext';
import { ProjectOnlyView } from '../features/project/ProjectOnlyView';
import { NativeSurfaceEffects } from '../platform/NativeSurfaceEffects';
import type { Connector, SessionSnapshot, Surface } from '../platform/desktopBridge';
import { usePlayback } from '../shared/motion/usePlayback';
import { followProjectIntents, isWindowsRoot, sameProjectRoot } from '../platform/projectIntent';

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
  const projectSnapshot = useProjectMapSnapshot();
  const bridge = useBridge();
  const storeMode = useSurfaceStore(useSessionUi.subscribe, useSessionUi.getState).mode;
  const visible = useSurfaceVisible();
  const companion = useCompanionPresence(snapshot, projectSnapshot);
  const mode = bridge.fixedSurface ?? storeMode;
  const [intent, setIntent] = useState<{ root: string; revision: number } | null>(null);
  const intentRevision = useRef(0);
  useEffect(() => {
    if (bridge.fixedSurface !== null && bridge.fixedSurface !== 'expanded') return;
    const stop = followProjectIntents(bridge, (root) => {
      const revision = ++intentRevision.current;
      void (async () => {
        const current = bridge.connector?.project();
        const selected = bridge.selectProject ? await bridge.selectProject(root).catch(() => false) : current ? sameProjectRoot(current.root, root, isWindowsRoot(current.root)) : false;
        if (revision !== intentRevision.current) return;
        useSessionUi.getState().exitReplay();
        setIntent(selected ? null : { root, revision });
        if (bridge.fixedSurface === null) bridge.showSurface('expanded');
      })();
    });
    return () => { intentRevision.current++; stop(); };
  }, [bridge]);
  return (
    <div className={`app app--${mode}`} data-companion-state={companion.state}>
      {bridge.kind === 'native' && <NativeSurfaceEffects />}
      <Activity mode={visible ? 'visible' : 'hidden'}>
      {underlay}
      {intent && bridge.connector ? (
        <ExpandedConnectView key={intent.revision} connector={bridge.connector} initialRoot={intent.root} onClose={() => setIntent(null)} />
      ) : snapshot ? (
        <Surfaces snapshot={snapshot} companion={companion} />
      ) : projectSnapshot ? (
        <ProjectOnlyView snapshot={projectSnapshot} mode={mode} companion={companion} />
      ) : (
        <div className="app__empty">
          {bridge.connector && mode === 'expanded' ? (
            <ExpandedConnectView connector={bridge.connector} />
          ) : bridge.connector && mode === 'island' ? (
            <IdleIsland companion={companion} onOpen={() => bridge.showSurface('expanded')} />
          ) : bridge.connector ? (
            <p className="app__empty-note" title={companion.description}>{companion.state === 'unknown' ? '?' : '−'} {companion.label}</p>
          ) : (
            <NoProjectState />
          )}
        </div>
      )}
      {(snapshot?.provenance === 'fixture' || projectSnapshot?.provenance === 'fixture') && (
        <div className="app__fixture-badge" role="note">
          {snapshot?.simulatedFeed ? 'Simulated live feed · demo fixture, not real agent activity' : 'Demo fixture · not real agent activity'}
        </div>
      )}
      </Activity>
    </div>
  );
};

/** Expanded keeps its native window controls throughout folder choice and mandatory Connect review. */
export const ExpandedConnectView = ({ connector, initialRoot, onClose, windowApi }: {
  readonly connector: Connector;
  readonly initialRoot?: string;
  readonly onClose?: () => void;
  readonly windowApi?: TitleBarWindowApi;
}) => {
  const bridge = useBridge();
  const nativeWindow = windowApi ?? expandedWindowChrome(bridge, typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const [previewRoot, setPreviewRoot] = useState(initialRoot ?? null);
  const previewPresence: CompanionPresence = { state: 'disconnected', label: 'Connect preview', description: 'Connect preview · confirm the settings review to connect this folder', records: [], activeUntil: null };
  const root = previewRoot;
  const project = root ? root.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1) || root : 'No project';
  return (
    <div className="expanded-dock">
      <div className="panel expanded" style={{ borderRadius: 28 }}>
        <TitleBar companion={previewPresence} nativeWindow={nativeWindow} project={project} agent="unknown" task="Review connection"
          taskVisible taskIsPlaceholder taskPrefix="Project ·" status="ready" statusLabel="Connect preview" />
        <div className="expanded__connect">
          <ConnectPanel connector={connector} onPreviewRootChange={setPreviewRoot} mapBesideReview {...(initialRoot ? { initialRoot } : {})} {...(onClose ? { onClose } : {})} />
        </div>
      </div>
    </div>
  );
};

const Surfaces = ({ snapshot, companion }: { readonly snapshot: SessionSnapshot; readonly companion: CompanionPresence }) => {
  const { graph, log, project } = snapshot;
  const bridge = useBridge();
  const { mode: storeMode, source, selectedNodeId, pinned, liveRun, replayRun, startReplay, exitReplay, selectNode, togglePin } = useSurfaceStore(useSessionUi.subscribe, useSessionUi.getState);
  const mode = bridge.fixedSurface ?? storeMode;
  const connected = bridge.connector?.project();
  const projectKey = connected ? JSON.stringify([connected.id, connected.root]) : project;
  /** Browser: switch in place. Native: show that surface's window (and hide this one). */
  const go = (surface: Surface) => bridge.showSurface(surface);
  /** "View changes": native Island hands the replay to the Mini Player window; elsewhere it plays in place. */
  const viewChanges = () => (bridge.kind === 'native' && mode === 'island' ? bridge.showSurface('mini', 'replay') : startReplay());
  const onTogglePin = () => {
    bridge.setPinned(!pinned);
    togglePin();
  };
  // Keep the session being reviewed stable while the current live snapshot continues to advance.
  const replaySnapshot = useMemo(() => snapshot, [replayRun, projectKey]);
  const replayScript = useMemo(() => compileReplay(replaySnapshot.log, replaySnapshot.graph), [replaySnapshot]);
  const isReplay = source === 'replay';
  const shownGraph = isReplay ? replaySnapshot.graph : graph;
  const insights = useMemo(() => deriveInsights(isReplay ? replaySnapshot.log : log), [isReplay, replaySnapshot, log]);

  // Live agent data (and the dev simulated feed) is followed by the live director; only the plain demo fixture plays the film.
  const followsLive = snapshot.provenance === 'live' || snapshot.simulatedFeed !== undefined;
  const follow = useLiveFollow(followsLive ? { log, graph, ...(snapshot.simulatedFeed ? { simulatedFeed: snapshot.simulatedFeed } : {}) } : null);

  // The demo film's clock follows wall time and stops once the completion offer has gone quiet.
  const live = usePlayback({ reducedMotionAt: 30, wallClock: true, autoplay: !followsLive, stopAt: liveScript.summary.detailAt + CTA_PROMINENT_SECONDS + 2 });
  const replay = usePlayback({ stopAt: replayScript.duration + 0.6, autoplay: false });

  // Activity reconnects effects on reveal while retaining these refs and the playback clocks.
  const startedLiveRun = useRef(0);
  const startedReplayRun = useRef(0);
  useEffect(() => {
    if (liveRun > 0 && liveRun !== startedLiveRun.current && !followsLive) {
      startedLiveRun.current = liveRun;
      live.restart();
    }
  }, [liveRun]);
  useEffect(() => {
    if (replayRun > 0 && replayRun !== startedReplayRun.current) {
      startedReplayRun.current = replayRun;
      replay.restart();
    }
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

  const script = isReplay ? replayScript : follow ? follow.script : liveScript;
  const t = isReplay ? replay.t : follow ? follow.t : live.t;
  const frame = evaluateFrame(script, shownGraph, t);
  const presence = derivePresence(script, shownGraph, frame, isReplay);

  const lastActivity = useRef<ReplayActivityState>({ previous: null, pending: false, run: replayRun });
  const [newActivity, setNewActivity] = useState(false);
  const leaveReplay = () => { replay.pause(); exitReplay(); };
  useEffect(() => {
    const next = trackReplayActivity(lastActivity.current, { projectKey, log, complete: isReplay && frame.ui.finished }, { followsLive, isReplay, playing: replay.playing, run: replayRun });
    lastActivity.current = next;
    setNewActivity(next.pending);
    if (next.returnToLive) leaveReplay();
  }, [projectKey, log, isReplay, frame.ui.finished, replay.playing, replayRun, followsLive, exitReplay]);

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
        onExit={leaveReplay}
        newActivity={newActivity}
        onBackToLive={leaveReplay}
      />
    ) : undefined;

  return (
    <LayoutGroup>
      {mode === 'island' && (
        <IslandMode companion={companion} script={script} frame={frame} presence={presence} onPinMini={() => go('mini')} onExpand={() => go('expanded')} onViewChanges={viewChanges} />
      )}
      {mode === 'mini' && (
        <MiniPlayer
          companion={companion}
          script={script}
          frame={frame}
          graph={shownGraph}
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
          companion={companion}
          script={script}
          frame={frame}
          graph={shownGraph}
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
