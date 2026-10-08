import type { ReactNode } from 'react';
import { LayoutGroup } from 'motion/react';
import { useBridge, useProjectMapSnapshot, useSessionSnapshot } from '../platform/BridgeContext';
import { IdleIsland } from '../features/modes/IdleIsland';
import { IslandMode } from '../features/modes/IslandMode';
import { useCompanionPresence } from '../features/modes/presenceClock';
import { derivePresence } from '../features/modes/presence';
import { canonicalScript } from '../features/session/model/canonicalScript';
import { evaluateFrame } from '../features/session/model/evaluateFrame';
import { frozenClock } from '../shared/motion/frozenClock';

/** Opt-in data for geometry tests; keep it outside the product entry and never alter React-owned DOM. */
export const IslandLabelFixture = ({ label, underlay }: { readonly label: string; readonly underlay?: ReactNode }) => {
  const bridge = useBridge();
  const snapshot = useSessionSnapshot();
  const project = useProjectMapSnapshot();
  const observed = useCompanionPresence(snapshot, project);
  const companion = { ...observed, label, description: `Demo fixture · ${label}`, activeUntil: null };
  const frame = snapshot ? evaluateFrame(canonicalScript, snapshot.graph, frozenClock() ?? 4) : null;
  const open = () => bridge.showSurface('expanded');
  return <div className="app app--island" title="Dev harness · Island label fixture">
    {underlay}
    <LayoutGroup>
      {snapshot && frame ? <IslandMode companion={companion} script={canonicalScript} frame={frame}
        presence={derivePresence(canonicalScript, snapshot.graph, frame, false)}
        onPinMini={() => bridge.showSurface('mini')} onExpand={open} onViewChanges={() => bridge.showSurface('expanded', 'replay')} />
        : <IdleIsland companion={companion} onOpen={open} />}
    </LayoutGroup>
    <div className="app__fixture-badge" role="note">Demo fixture · custom Island label, not real agent activity</div>
  </div>;
};
