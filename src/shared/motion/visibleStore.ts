import { useMemo, useRef, useSyncExternalStore } from 'react';
import { isSurfaceVisible, subscribeSurfaceVisibility } from './surfaceVisibility';

/** Suspend only renderer subscriptions. The bridge still ingests and persists its own data. */
export const createVisibleStore = <T,>(subscribe: (listener: () => void) => () => void, read: () => T) => {
  let current = read();
  return {
    getSnapshot: () => {
      if (isSurfaceVisible()) current = read();
      return current;
    },
    subscribe: (listener: () => void) => {
      let disposed = false;
      let stopData: (() => void) | undefined;
      const connect = () => {
        stopData?.(); stopData = undefined;
        if (isSurfaceVisible()) stopData = subscribe(() => { if (!disposed && isSurfaceVisible()) listener(); });
      };
      connect();
      const stopVisibility = subscribeSurfaceVisibility(() => {
        connect();
        if (isSurfaceVisible()) listener();
      });
      return () => { disposed = true; stopData?.(); stopVisibility(); };
    },
  };
};

export const useSurfaceStore = <T,>(subscribe: (listener: () => void) => () => void, read: () => T): T => {
  const reader = useRef(read);
  reader.current = read;
  const store = useMemo(() => createVisibleStore(subscribe, () => reader.current()), [subscribe]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
