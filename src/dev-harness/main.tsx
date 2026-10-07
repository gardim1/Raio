import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeProvider } from '../platform/BridgeContext';
import { createFixtureBridge, createProjectFixtureBridge, createSimulatedFeedBridge, type SimulatedFeedPace } from '../platform/fixtureBridge';
import type { ProjectHooksState } from '../platform/desktopBridge';
import { freezeClock } from '../shared/motion/frozenClock';
import { applyTokens } from '../tokens/applyTokens';
import { HarnessApp } from './HarnessApp';
import '../app/styles/raio.css';
import './harness.css';

applyTokens();

// Deterministic screenshots: ?t=<seconds> freezes every clock; ?view= and ?replay=1 pick the scene.
const params = new URLSearchParams(window.location.search);
const t = params.get('t');
freezeClock(t === null ? null : Number(t));

// ?feed=steady|burst serves the demo session as a simulated live feed (events appended over time) so the
// live director can be exercised without an agent. With ?t= the feed clock is frozen at that many seconds.
const feed = params.get('feed');
const pace: SimulatedFeedPace | null = feed === 'steady' || feed === 'burst' ? feed : null;
const hookFlag = params.get('hooks');
const hooksState: ProjectHooksState | undefined = hookFlag === 'current' || hookFlag === 'outdated' || hookFlag === 'unknown' ? hookFlag : undefined;
const bridge = params.get('project-only') === '1' ? createProjectFixtureBridge({ ...(hooksState ? { hooksState } : {}) }) : pace ? createSimulatedFeedBridge({ pace, ...(t === null ? {} : { fixedNowMs: Number(t) * 1000 }) }) : createFixtureBridge();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <BridgeProvider bridge={bridge}>
      <HarnessApp />
    </BridgeProvider>
  </StrictMode>,
);
