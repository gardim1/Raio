import { createContext, type ReactNode, useContext } from 'react';
import { useSurfaceStore } from '../shared/motion/visibleStore';
import type { DesktopBridge, SessionSnapshot } from './desktopBridge';
import { readProjectMap } from './projectMapBridge';
import type { ProjectMapSnapshot } from '../features/project/projectMap';

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
  return useSurfaceStore(bridge.subscribe, bridge.currentSession);
};

/** A connected project with no observed session; bridge notifications also cover inventory/scan updates. */
export const useProjectMapSnapshot = (): ProjectMapSnapshot | null => {
  const bridge = useBridge();
  const read = () => readProjectMap(bridge);
  return useSurfaceStore(bridge.subscribe, read);
};
