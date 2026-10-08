import { motion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { createIslandHover, followIslandPointer } from './islandHover';
import { CROSSFADE, ISLAND_TRANSITION } from './presence';

/** One capsule and hover lifetime for session, quiet, unavailable and disconnected states. */
export const IslandShell = ({ description, collapsed, heading, status, children }: {
  readonly description: string;
  readonly collapsed: ReactNode;
  readonly heading?: ReactNode;
  readonly status?: ReactNode;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const bridge = useBridge();
  const visible = useSurfaceVisible();
  const native = bridge.kind === 'native' && bridge.fixedSurface === 'island';
  const hover = useRef<ReturnType<typeof createIslandHover> | null>(null);
  useEffect(() => {
    if (!visible) { setOpen(false); return; }
    const controller = createIslandHover(setOpen);
    hover.current = controller;
    const stop = native ? followIslandPointer(handler => bridge.onIslandPointer(handler), controller.pointer) : () => {};
    return () => { hover.current = null; stop(); controller.dispose(); };
  }, [bridge, native, visible]);
  const shown = visible && open;
  return <div className="island-dock">
    {/* Animate this capsule's own geometry; a shared surface ID can scale it from Expanded past its width cap. */}
    <motion.div layout layoutDependency={shown}
      transition={shown ? ISLAND_TRANSITION : { ...ISLAND_TRANSITION, stiffness: 520 }}
      className={`island${shown ? ' island--open' : ''}`} style={{ borderRadius: shown ? 26 : 17 }}
      onPointerEnter={native ? undefined : () => hover.current?.pointer(true)}
      onPointerLeave={native ? undefined : () => hover.current?.pointer(false)}
      onFocus={() => hover.current?.focus(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover.current?.focus(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); hover.current?.escape(); } }}
      onClick={event => event.stopPropagation()}
      title={description} aria-label={`Raio: ${description}`} aria-expanded={shown}>
      {/* Keep existing geometry/label observers above; the focusable disclosure semantics live on this button. */}
      <div className={shown ? 'island__open' : undefined}>
        <div className={shown ? 'island__row island__header' : undefined}>
          <button type="button" className={`island__trigger ${shown ? 'island__heading' : 'island__closed'}`}
            aria-label={`Raio: ${description}`} aria-expanded={shown} aria-controls={previewId}
            onClick={() => setOpen(true)}>
            <span className="island__collapsed-content" hidden={shown}>{collapsed}</span>
            {shown && <span className="island__heading-content">{heading ?? collapsed}</span>}
          </button>
          {shown && status}
        </div>
        <motion.div id={previewId} role="group" aria-label="Island preview" className="island__preview" hidden={!shown}
          initial={false} animate={{ opacity: shown ? 1 : 0, filter: shown ? 'blur(0px)' : 'blur(4px)' }}
          transition={{ ...CROSSFADE, delay: shown ? 0.08 : 0 }}>
          {children}
        </motion.div>
      </div>
    </motion.div>
  </div>;
};
