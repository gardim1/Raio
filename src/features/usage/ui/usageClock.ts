import { useEffect, useState } from 'react';
import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../../shared/motion/surfaceVisibility';

interface UsageClockPorts {
  visible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
  afterMinute(callback: () => void): () => void;
}
export const startUsageClock = (notify: () => void, ports: UsageClockPorts): (() => void) => {
  let stopped = false, cancel: (() => void) | undefined;
  const tick = () => {
    cancel = undefined;
    if (stopped || !ports.visible()) return;
    notify(); cancel = ports.afterMinute(tick);
  };
  const visibility = () => { cancel?.(); cancel = undefined; if (ports.visible()) tick(); };
  const unsubscribe = ports.subscribeVisibility(visibility);
  visibility();
  return () => { stopped = true; cancel?.(); unsubscribe(); };
};
export const useUsageNow = (active: boolean): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    return startUsageClock(() => setNow(Date.now()), {
      visible: isSurfaceVisible, subscribeVisibility: subscribeSurfaceVisibility,
      afterMinute: callback => { const timer = setTimeout(callback, 60_000); return () => clearTimeout(timer); },
    });
  }, [active]);
  return now;
};
