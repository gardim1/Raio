import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeProvider } from '../platform/BridgeContext';
import { createFixtureBridge } from '../platform/fixtureBridge';
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

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <BridgeProvider bridge={createFixtureBridge()}>
      <HarnessApp />
    </BridgeProvider>
  </StrictMode>,
);
