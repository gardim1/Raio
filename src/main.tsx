import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { BridgeProvider } from './platform/BridgeContext';
import { createBridge } from './platform/createBridge';
import { applyTokens } from './tokens/applyTokens';
import './app/styles/raio.css';
import './platform/native.css';

applyTokens();

const bridge = createBridge();
if (bridge.kind === 'native' && bridge.fixedSurface) {
  document.documentElement.classList.add('native', `surface-${bridge.fixedSurface}`);
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <BridgeProvider bridge={bridge}>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
