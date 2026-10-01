import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { useSessionUi } from '../features/session/store/sessionStore';
import { setNativeSurfaceVisible } from '../shared/motion/surfaceVisibility';
import { useBridge } from './BridgeContext';

/** Extra pixels around the capsule that still count as "on the Island". */
const HIT_PADDING = 2;

/**
 * Native-window behaviour that has no browser equivalent: the Island publishes its capsule
 * rectangle for click-through, the Mini Player header drags the OS window, and a surface
 * shown with an intent (e.g. "replay") acts on it.
 */
export const NativeSurfaceEffects = () => {
  const bridge = useBridge();
  const startReplay = useSessionUi((s) => s.startReplay);
  const surface = bridge.fixedSurface;

  useEffect(() => {
    if (surface !== 'island') return;
    let frame = 0;
    let observed: Element | null = null;
    const publish = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('.island');
        if (!el) return;
        // Layout box, not getBoundingClientRect: the open/close spring animates a transform, and the
        // transformed box at the start of the animation would leave the final capsule click-through.
        let x = 0;
        let y = 0;
        for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
          x += node.offsetLeft;
          y += node.offsetTop;
        }
        bridge.setIslandHitRect({ x: x - HIT_PADDING, y: y - HIT_PADDING, width: el.offsetWidth + 2 * HIT_PADDING, height: el.offsetHeight + 2 * HIT_PADDING });
      });
    };
    const resize = new ResizeObserver(publish);
    // The capsule element can be re-created by layout animations; re-attach when it changes.
    const attach = () => {
      const el = document.querySelector('.island');
      if (el && el !== observed) {
        if (observed) resize.unobserve(observed);
        resize.observe(el);
        observed = el;
      }
      publish();
    };
    const mutations = new MutationObserver(attach);
    mutations.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [surface, bridge]);

  useEffect(() => {
    if (surface !== 'mini') return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (e.button !== 0 || !target?.closest('.mini__head') || target.closest('button')) return;
      void getCurrentWindow().startDragging();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [surface]);

  useEffect(() => {
    // Floating surfaces start hidden; the core reports every later show/hide.
    void getCurrentWindow()
      .isVisible()
      .then(setNativeSurfaceVisible)
      .catch(() => {});
    const unlisten = listen<boolean>('surface-visible', (event) => setNativeSurfaceVisible(event.payload));
    return () => void unlisten.then((stop) => stop());
  }, []);

  useEffect(() => {
    const unlisten = listen<string>('surface-intent', (event) => {
      if (event.payload === 'replay') startReplay();
    });
    return () => void unlisten.then((stop) => stop());
  }, [startReplay]);

  return null;
};
