import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { createIslandHover, followIslandPointer } from './islandHover';
import { requestCharacterReaction } from '../raio/character';
import { IslandUsage } from './IslandUsage';
import { observeIslandPreviewHeight } from './islandLayout';

/** Prototype fitIsland formula, capped so the collapsed hit rect stays inside the preview. */
export const fitIslandWidth = (labelWidth: number): number =>
  Math.min(340, Math.max(150, Math.ceil(Number.isFinite(labelWidth) ? labelWidth : 0) + 28 + 16 + 6 + 40));

/** One capsule and hover lifetime for session, quiet, unavailable and disconnected states. */
export const IslandShell = ({ description, collapsed, children, onPinMini, onExpand }: {
  readonly description: string;
  readonly collapsed: ReactNode;
  readonly children: ReactNode;
  readonly onPinMini: () => void;
  readonly onExpand: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(150);
  const [settled, setSettled] = useState(true);
  const capsule = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const bridge = useBridge();
  const visible = useSurfaceVisible();
  const native = bridge.kind === 'native' && bridge.fixedSurface === 'island';
  const shown = visible && open;
  // Keep inert visuals for the 200ms opacity exit; hidden surfaces and reduced motion clean up immediately.
  const contentVisible = visible && (shown || !settled);
  useEffect(() => {
    if (shown) { setSettled(false); return; }
    if (!visible || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setSettled(true); return; }
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), 200);
    return () => clearTimeout(timer);
  }, [shown, visible, settled]);
  const hover = useRef<ReturnType<typeof createIslandHover> | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const label = capsule.current?.querySelector<HTMLElement>('.island__label');
    if (!label) return;
    let alive = true;
    const measure = () => { if (alive) setWidth(fitIslandWidth(label.scrollWidth)); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    const stopHeight = observeIslandPreviewHeight(capsule.current!);
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); stopHeight(); };
  }, [collapsed, visible]);
  useEffect(() => {
    if (!visible) { setOpen(false); return; }
    const controller = createIslandHover(setOpen);
    hover.current = controller;
    const stop = native ? followIslandPointer(handler => bridge.onIslandPointer(handler), controller.pointer) : () => {};
    return () => { hover.current = null; stop(); controller.dispose(); };
  }, [bridge, native, visible]);
  return <div className="island-dock">
    {/* CSS changes layout dimensions, so the native ResizeObserver publishes the actual hit rect. */}
    <div ref={capsule} className={`island${shown ? ' island--open' : ''}`}
      style={{ '--island-width': `${width}px` } as CSSProperties}
      onPointerEnter={native ? undefined : () => hover.current?.pointer(true)}
      onPointerLeave={native ? undefined : () => hover.current?.pointer(false)}
      onFocus={() => hover.current?.focus(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.current?.focus(false); }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.stopPropagation();
        // Preview controls become inert on collapse; return focus before hiding the focused control.
        if ((event.target as HTMLElement | null)?.closest?.('.island__preview')) {
          event.currentTarget.querySelector<HTMLButtonElement>('.island__trigger')?.focus();
        }
        hover.current?.escape();
      }}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
      title={description} aria-label={`Raio: ${description}`} aria-expanded={shown}>
      {/* Keep existing geometry/label observers above; the focusable disclosure semantics live on this button. */}
      <button type="button" className="island__trigger island__closed"
        aria-label={`Raio: ${description}`} aria-expanded={shown} aria-controls={previewId}
        onClick={() => setOpen(true)}>
        <span className="island__collapsed-content">{collapsed}</span>
      </button>
      <div id={previewId} role="group" aria-label="Island preview" className="island__preview"
        aria-hidden={!shown} inert={!shown}>
        <div className="island__content"><div className="island__content-body">{children}{contentVisible && <IslandUsage onOpenChange={expanded => { if (expanded) hover.current?.renew(); }} />}</div></div>
        <div className="island__actions">
          <button type="button" title="Open Mini Player" aria-label="Open Mini Player" onClick={onPinMini}>Open Mini Player</button>
          <button type="button" title="Open window" aria-label="Open window" onClick={onExpand}>Open window</button>
          {contentVisible && <button type="button" className="island__cookie" title="Give Raio a cookie" aria-label="Give Raio a cookie"
            onClick={event => { event.stopPropagation(); requestCharacterReaction('cookie'); }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden focusable="false">
              <path d="M12.5 7.5A5.5 5.5 0 1 1 7 2a2 2 0 0 0 2 2 2 2 0 0 0 3.5 3.5Z" />
              <circle cx="4.5" cy="6" r=".6" fill="currentColor" stroke="none" />
              <circle cx="6" cy="9.5" r=".6" fill="currentColor" stroke="none" />
              <circle cx="9.5" cy="9" r=".6" fill="currentColor" stroke="none" />
            </svg>
          </button>}
        </div>
      </div>
    </div>
  </div>;
};
