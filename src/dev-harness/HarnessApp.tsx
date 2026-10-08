import { useEffect, useState } from 'react';
import { App } from '../app/App';
import { type DisplayMode, useSessionUi } from '../features/session/store/sessionStore';
import { DesktopBackdrop } from './DesktopBackdrop';
import { FilmMode } from './FilmMode';
import { type HarnessView, MODES, ModeDock } from './ModeDock';
import { StatesGallery } from './StatesGallery';
import { IslandLabelFixture } from './IslandLabelFixture';

/** Development-only review harness around the product app. Never shipped. */
const VIEWS: readonly HarnessView[] = ['film', 'island', 'mini', 'expanded', 'states'];
const initialView = (): HarnessView => {
  const v = new URLSearchParams(window.location.search).get('view');
  return VIEWS.find((x) => x === v) ?? 'expanded';
};

/** `?chrome=0` hides the dock and label so reference comparisons only see the rendered scene. */
const showChrome = new URLSearchParams(window.location.search).get('chrome') !== '0';
/** `?feed=` serves the demo session as a simulated live feed instead of the concept film. */
const feedPace = new URLSearchParams(window.location.search).get('feed');
const simulatedFeed = feedPace === 'steady' || feedPace === 'burst';

export const HarnessApp = () => {
  const islandLabel = new URLSearchParams(window.location.search).get('island-label');
  const [view, setView] = useState<HarnessView>(initialView);
  const setMode = useSessionUi((s) => s.setMode);
  const restartLive = useSessionUi((s) => s.restartLive);
  const startReplay = useSessionUi((s) => s.startReplay);
  const mode = useSessionUi((s) => s.mode);

  const show = (next: HarnessView) => {
    setView(next);
    if (next === 'island' || next === 'mini' || next === 'expanded') setMode(next as DisplayMode);
  };

  useEffect(() => {
    const first = initialView();
    if (first === 'island' || first === 'mini' || first === 'expanded') setMode(first);
    if (new URLSearchParams(window.location.search).get('replay') === '1') startReplay();
  }, []);

  // Keep the dock in sync when the product itself changes surface (e.g. "Pin as mini player").
  useEffect(() => {
    setView((v) => (v === 'film' || v === 'states' ? v : mode));
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const m = MODES.find((x) => x.key === e.key);
      if (m) show(m.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      {showChrome && <div className="harness-label">{simulatedFeed ? `Dev harness · simulated live feed (${feedPace}) · demo fixture` : 'Dev harness · demo fixture'}</div>}
      {view === 'film' && (
        <div className="app">
          <FilmMode />
        </div>
      )}
      {view === 'states' && (
        <div className="app">
          <StatesGallery />
        </div>
      )}
      {view !== 'film' && view !== 'states' && (view === 'island' && islandLabel !== null
        ? <IslandLabelFixture label={islandLabel} underlay={<DesktopBackdrop />} />
        : <App underlay={<DesktopBackdrop />} />)}
      {showChrome && <ModeDock mode={view} onMode={show} onRunLive={simulatedFeed ? () => window.location.reload() : restartLive} onViewChanges={startReplay} />}
    </>
  );
};
