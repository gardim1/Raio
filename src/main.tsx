import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { BridgeProvider } from './platform/BridgeContext';
import { createBridge } from './platform/createBridge';
import { applyTokens } from './tokens/applyTokens';
import './app/styles/raio.css';

applyTokens();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(
  <StrictMode>
    <BridgeProvider bridge={createBridge()}>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
