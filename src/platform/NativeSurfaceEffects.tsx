import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect } from 'react';
import { useSessionUi } from '../features/session/store/sessionStore';
import { isSurfaceVisible, setNativeSurfaceVisible, useSurfaceVisible } from '../shared/motion/surfaceVisibility';
import type { DesktopBridge } from './desktopBridge';
import { useBridge } from './BridgeContext';
import { takeSurfaceIntent } from './nativeBridge';
import { followSurfaceIntent } from './surfaceIntentFollower';
import { trackSurfaceVisibility } from './surfaceVisibilityTracker';
import { canStartMiniDrag } from '../features/modes/miniDrag';

/** Extra pixels around the capsule that still count as "on the Island". */
const HIT_PADDING = 2;

/**
 * Native-window behaviour that has no browser equivalent: the Island publishes its capsule
 * rectangle for click-through, the Mini Player header drags the OS window, and a surface
 * shown with an intent (e.g. "replay") acts on it.
 */
export const observeIslandHitRect = (bridge: Pick<DesktopBridge, 'setIslandHitRect'>, visible: boolean): (() => void) => {
  if (!visible) return () => {};
  let disposed = false;
  let frame = 0;
  let observed: Element | null = null;
  const publish = () => {
    if (disposed || !isSurfaceVisible()) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (disposed || !isSurfaceVisible()) return;
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
    if (disposed || !isSurfaceVisible()) return;
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
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
  };
};

export const NativeSurfaceEffects = () => {
  const bridge = useBridge();
  const startReplay = useSessionUi((s) => s.startReplay);
  const surface = bridge.fixedSurface;
  const visible = useSurfaceVisible();

  useEffect(() => observeIslandHitRect(bridge, visible && surface === 'island'), [surface, bridge, visible]);

  useEffect(() => {
    if (surface !== 'mini' || !visible) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!isSurfaceVisible() || !target?.closest('.mini__head') || !canStartMiniDrag(target, e.button)) return;
      void getCurrentWindow().startDragging();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [surface, visible]);

  useEffect(() => {
    // Floating surfaces start hidden; the core reports every later show/hide. A minimized or occluded
    // window is treated like a hidden one so its animations stop (see surfaceVisibilityTracker.ts).
    const win = getCurrentWindow();
    return trackSurfaceVisibility(
      {
        isShown: () => win.isVisible(),
        isMinimized: () => win.isMinimized(),
        // Window-scoped: the core targets each surface with emit_to; a global listen() would receive them all.
        onShownChanged: (handler) => getCurrentWebviewWindow().listen<boolean>('surface-visible', (event) => handler(event.payload)),
        // There is no minimize event; a minimize/restore resizes, moves and defocuses the window.
        onWindowChanged: async (handler) => {
          const stops = await Promise.all([win.onResized(handler), win.onMoved(handler), win.onFocusChanged(handler)]);
          return () => stops.forEach((stop) => stop());
        },
        isPageHidden: () => document.visibilityState === 'hidden',
        onPageVisibilityChanged: (handler) => {
          document.addEventListener('visibilitychange', handler);
          return () => document.removeEventListener('visibilitychange', handler);
        },
      },
      setNativeSurfaceVisible,
    );
  }, []);

  useEffect(() => {
    // The core keeps the intent pending until this window pulls it (a push could land before the listener
    // exists), then emits later ones. Listen first, pull once, apply both the same way.
    return followSurfaceIntent(
      {
        listen: (handler) => getCurrentWebviewWindow().listen<string>('surface-intent', (event) => handler(event.payload)),
        take: () => takeSurfaceIntent(),
      },
      (intent) => {
        if (intent === 'replay') startReplay();
      },
    );
  }, [startReplay]);

  return null;
};
