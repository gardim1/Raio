import { useEffect, useMemo, useState } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { SessionSnapshot } from '../../platform/desktopBridge';
import type { ProjectMapSnapshot } from '../project/projectMap';
import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../shared/motion/surfaceVisibility';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { deriveCompanionPresence, type CompanionPresence, type PresenceInput } from './companionPresence';
import { factsFromLog } from './presenceFacts';

/** One expiry timeout, never an idle polling interval; visibility changes reconcile synchronously. */
export const runPresenceClock = ({ input, onChange, now = Date.now }: {
  readonly input: PresenceInput;
  readonly onChange: (presence: CompanionPresence) => void;
  readonly now?: () => number;
}): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const refresh = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || !isSurfaceVisible()) return;
    const at = now();
    const presence = deriveCompanionPresence(input, at);
    onChange(presence);
    if (presence.activeUntil !== null) timer = setTimeout(refresh, Math.max(1, presence.activeUntil - at));
  };
  const stopVisibility = subscribeSurfaceVisibility(refresh);
  refresh();
  return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); stopVisibility(); };
};

/** Older adapters/fixtures have normalized logs; absent native health remains explicitly unknown. */
export const fallbackPresenceInput = (snapshot: SessionSnapshot | null, project: ProjectMapSnapshot | null, fixture: boolean): PresenceInput => ({
  connected: snapshot !== null || project !== null,
  available: fixture || (snapshot?.core ?? project?.core) != null,
  facts: snapshot ? factsFromLog(snapshot.log).map(fact => ({ ...fact, source: fixture ? 'Demo fixture' : fact.source })) : [],
  core: snapshot?.core ?? project?.core ?? null,
});

export const useCompanionPresence = (snapshot: SessionSnapshot | null, project: ProjectMapSnapshot | null): CompanionPresence => {
  const bridge = useBridge();
  const native = useSurfaceStore(bridge.subscribe, () => bridge.projectPresence?.() ?? null);
  const input = useMemo(() => native ?? { ...fallbackPresenceInput(snapshot, project, bridge.kind === 'fixture'), hooks: bridge.projectHooksState?.() }, [native, snapshot, project, bridge]);
  // Fixture chronology stays in its recorded clock; only elapsed wall time after arrival is added.
  const cursor = useMemo(() => ({ wall: Date.now(), fixtureAt: !native && snapshot?.provenance === 'fixture' ? input.facts.at(-1)?.at : undefined }), [input, native, snapshot]);
  const [, repaint] = useState(0);
  const now = () => cursor.fixtureAt === undefined ? Date.now() : cursor.fixtureAt + Date.now() - cursor.wall;
  useEffect(() => runPresenceClock({ input, now, onChange: () => repaint(n => n + 1) }), [input, cursor]);
  return deriveCompanionPresence(input, now());
};
