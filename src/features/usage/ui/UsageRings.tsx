import { useEffect, useId, useRef, useState } from 'react';
import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../../shared/motion/surfaceVisibility';
import { usageWindowView, USAGE_STALE_AFTER_MS, type ClaudeUsageState } from '../claudeUsage';
import { UsageDetails } from './UsageDetails';
import { useClaudeUsage } from './useClaudeUsage';
import { useUsageNow } from './usageClock';

export interface UsageRingsProps {
  readonly state: ClaudeUsageState;
  /** Compact details stay in flow so the Island can include them in its native hit rect. */
  readonly compact?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Deterministic fixture clock; omitted by product callers. */
  readonly nowMs?: number;
}
export const UsageRings = ({ state, compact = false, onOpenChange, nowMs }: UsageRingsProps) => {
  const clock = useUsageNow(state.status === 'reading' && nowMs === undefined);
  const now = nowMs ?? clock, id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const callback = useRef(onOpenChange); callback.current = onOpenChange;
  useEffect(() => { callback.current?.(open); }, [open]);
  useEffect(() => () => callback.current?.(false), []);
  useEffect(() => subscribeSurfaceVisibility(() => { if (!isSurfaceVisible()) setOpen(false); }), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const windows = state.status === 'reading' ? [
    { id: 'sevenDay' as const, radius: 16, view: usageWindowView(state.latest, 'sevenDay', now) },
    { id: 'fiveHour' as const, radius: 10, view: usageWindowView(state.latest, 'fiveHour', now) },
  ] : [];
  const stale = state.status === 'reading' && now - state.latest.receivedAtMs > USAGE_STALE_AFTER_MS;
  const unavailable = !windows.some(window => window.view.kind === 'value');
  return <div ref={root} className={`usage-rings${compact ? ' usage-rings--compact' : ''}${stale ? ' usage-rings--stale' : ''}`} data-usage-status={state.status}
    onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onPointerEnter={() => setOpen(true)}
    onPointerLeave={() => { if (!root.current?.contains(document.activeElement)) setOpen(false); }}
    onFocus={() => setOpen(true)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
      if (event.key === 'Escape' && open) {
        event.stopPropagation(); event.preventDefault();
        root.current?.querySelector<HTMLButtonElement>('.usage-rings__button')?.focus({ preventScroll: true });
        setOpen(false);
      }
    }}>
    <button type="button" className="usage-rings__button" aria-label="Claude plan usage" title="Claude plan usage" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>
      <svg className="usage-rings__svg" viewBox="0 0 40 40" aria-hidden="true">
        {windows.map(({ id: windowId, radius, view }) => <g key={windowId} data-window={windowId} data-kind={view.kind} className={`usage-rings__${windowId}`}>
          {view.kind === 'value' ? <>
            <circle className="usage-rings__track" cx="20" cy="20" r={radius} />
            <circle className="usage-rings__fill" data-window={windowId} r={radius} cx="20" cy="20" pathLength="100" strokeDasharray={`${view.usedPercentage} 100`} transform="rotate(-90 20 20)" />
          </> : <text className="usage-rings__missing" x="20" y={windowId === 'fiveHour' ? 23 : 8}>—</text>}
        </g>)}
        {!windows.length && <text className="usage-rings__missing" x="20" y="24">—</text>}
      </svg>
      {unavailable && <span className="usage-rings__unavailable">Usage unavailable</span>}
    </button>
    {open && <div className="usage-details-wrap"><UsageDetails state={state} nowMs={now} id={id} /></div>}
  </div>;
};

/** Expanded hides opt-out entirely; the pure shared component can demonstrate/explain it. */
export const ExpandedUsageRings = () => {
  const state = useClaudeUsage();
  return state.status === 'disabled' ? null : <UsageRings state={state} />;
};
