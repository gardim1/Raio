import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import { useSurfaceVisible } from '../../shared/motion/surfaceVisibility';
import { createIslandHover, followIslandPointer } from './islandHover';
import { CROSSFADE, ISLAND_TRANSITION } from './presence';

/** One capsule and hover lifetime for session, quiet, unavailable and disconnected states. */
export const IslandShell = ({ description, collapsed, children }: {
  readonly description: string;
  readonly collapsed: ReactNode;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
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
      tabIndex={0} aria-label={`Raio: ${description}`} title={description} aria-expanded={shown}>
      <AnimatePresence mode="popLayout" initial={false}>
        {shown ? <motion.div key="open" className="island__open" initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)', transition: { ...CROSSFADE, delay: 0.08 } }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
          {children}
        </motion.div> : <motion.div key="closed" className="island__closed" initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { ...CROSSFADE, delay: 0.06 } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          {collapsed}
        </motion.div>}
      </AnimatePresence>
    </motion.div>
  </div>;
};
