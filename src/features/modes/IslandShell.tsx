import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { createIslandHover, followIslandPointer } from './islandHover';

/** Prototype fitIsland formula, capped so the collapsed hit rect stays inside the preview. */
export const fitIslandWidth = (labelWidth: number): number =>
  Math.min(340, Math.max(150, Math.ceil(Number.isFinite(labelWidth) ? labelWidth : 0) + 28 + 16 + 6 + 40));

/** One capsule and hover lifetime for session, quiet, unavailable and disconnected states. */
export const IslandShell = ({ description, collapsed, children }: {
  readonly description: string;
  readonly collapsed: ReactNode;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(150);
  const capsule = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const bridge = useBridge();
  const visible = useSurfaceVisible();
  const native = bridge.kind === 'native' && bridge.fixedSurface === 'island';
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
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); };
  }, [collapsed, visible]);
  useEffect(() => {
    if (!visible) { setOpen(false); return; }
    const controller = createIslandHover(setOpen);
    hover.current = controller;
    const stop = native ? followIslandPointer(handler => bridge.onIslandPointer(handler), controller.pointer) : () => {};
    return () => { hover.current = null; stop(); controller.dispose(); };
  }, [bridge, native, visible]);
  const shown = visible && open;
  return <div className="island-dock">
    {/* CSS changes layout dimensions, so the native ResizeObserver publishes the actual hit rect. */}
    <div ref={capsule} className={`island${shown ? ' island--open' : ''}`}
      style={{ '--island-width': `${width}px` } as CSSProperties}
      onPointerEnter={native ? undefined : () => hover.current?.pointer(true)}
      onPointerLeave={native ? undefined : () => hover.current?.pointer(false)}
      onFocus={() => hover.current?.focus(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.current?.focus(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); hover.current?.escape(); } }}
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
        {children}
      </div>
    </div>
  </div>;
};
