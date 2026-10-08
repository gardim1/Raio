import { useMemo } from 'react';
import { useBridge } from '../../../platform/BridgeContext';
import type { DesktopBridge } from '../../../platform/desktopBridge';
import { useSurfaceStore } from '../../../shared/motion/visibleStore';
import { fallbackPresenceInput } from '../../modes/presenceClock';
import type { PresenceInput } from '../../modes/companionPresence';

const noSubscribe = () => () => {};
/** Chrome can be embedded without a provider in static previews; there are no observations there. */
const useCharacterBridge = (): DesktopBridge | undefined => {
  // Always invokes the same context hook; only the explicit missing-provider error is optional.
  try { return useBridge(); } catch (error) {
    if (error instanceof Error && error.message === 'useBridge requires a BridgeProvider') return undefined;
    throw error;
  }
};
export const useCharacterObservation = () => {
  const bridge = useCharacterBridge();
  const native = useSurfaceStore(bridge?.subscribe ?? noSubscribe, () => bridge?.projectPresence?.() ?? null);
  const snapshot = useSurfaceStore(bridge?.subscribe ?? noSubscribe, () => bridge?.currentSession() ?? null);
  const input: PresenceInput | null = useMemo(() => native ?? (bridge && snapshot ? fallbackPresenceInput(snapshot, null, bridge.kind === 'fixture') : null), [native, snapshot, bridge]);
  const cursor = useMemo(() => ({ wall: Date.now(), fixtureAt: !native && snapshot?.provenance === 'fixture' ? input?.facts.at(-1)?.at : undefined }), [input, native, snapshot]);
  const now = useMemo(() => () => cursor.fixtureAt === undefined ? Date.now() : cursor.fixtureAt + Date.now() - cursor.wall, [cursor]);
  return { input, now };
};
