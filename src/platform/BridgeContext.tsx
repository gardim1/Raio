import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { DesktopBridge, SessionSnapshot } from './desktopBridge';

const BridgeContext = createContext<DesktopBridge | null>(null);

export const BridgeProvider = ({ bridge, children }: { readonly bridge: DesktopBridge; readonly children: ReactNode }) => (
  <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>
);

/** The desktop bridge of this window. */
export const useBridge = (): DesktopBridge => {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('useBridge requires a BridgeProvider');
  return bridge;
};

/** The session currently exposed by the desktop bridge (null when none). */
export const useSessionSnapshot = (): SessionSnapshot | null => {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('useSessionSnapshot requires a BridgeProvider');
  return useSyncExternalStore(bridge.subscribe, bridge.currentSession);
};
