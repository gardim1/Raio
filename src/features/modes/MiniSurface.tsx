import { motion } from 'motion/react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { clamp } from '../../shared/motion/easing';
import { IconButton } from '../../shared/ui/Button';
import { CollapseIcon, ExpandIcon, PinIcon } from '../../shared/ui/icons';
import { tokens } from '../../tokens';
import type { AgentStatusState } from '../session/model/script';
import { MORPH_TRANSITION } from './presence';
import type { CompanionPresence } from './companionPresence';

const SIZE = tokens.size.miniPlayer;
interface Rect { x: number; y: number; w: number; h: number }
const initialRect = (): Rect => ({
  w: SIZE.width, h: SIZE.height,
  x: Math.max(16, (typeof window === 'undefined' ? 0 : window.innerWidth) - SIZE.width - 28),
  y: Math.max(16, (typeof window === 'undefined' ? 0 : window.innerHeight) - SIZE.height - 104),
});

export interface MiniSurfaceProps {
  readonly companion?: CompanionPresence;
  readonly project: string;
  readonly projectTitle?: string;
  readonly status: AgentStatusState;
  readonly stateLabel: string;
  readonly pinned: boolean;
  readonly onTogglePin: () => void;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/** Shared Mini chrome and gestures, whether it displays a session or a project before telemetry. */
export const MiniSurface = ({ project, projectTitle, status, stateLabel, pinned, onTogglePin, onExpand, onCollapse, children, footer, companion }: MiniSurfaceProps) => {
  const [rect, setRect] = useState<Rect>(initialRect);
  const gesture = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origin: Rect } | null>(null);
  const begin = useCallback(
    (kind: 'move' | 'resize') => (e: ReactPointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      gesture.current = { kind, startX: e.clientX, startY: e.clientY, origin: rect };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, [rect],
  );
  const move = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === 'move') {
      setRect({ ...g.origin, x: clamp(g.origin.x + dx, 8, window.innerWidth - g.origin.w - 8), y: clamp(g.origin.y + dy, 8, window.innerHeight - g.origin.h - 8) });
    } else {
      setRect({ ...g.origin, w: clamp(g.origin.w + dx, SIZE.minWidth, SIZE.maxWidth), h: clamp(g.origin.h + dy, SIZE.minHeight, SIZE.maxHeight) });
    }
  };
  const end = () => (gesture.current = null);
  return (
    <motion.div layoutId="raio-surface" layoutDependency={`${rect.w}x${rect.h}`} transition={MORPH_TRANSITION}
      className="mini" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: 20 }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <header className="mini__head" onPointerDown={begin('move')}>
        <span className={`mini__status mini__status--${status}`} data-presence={companion?.state} role="img" aria-label={companion?.description ?? stateLabel} title={companion?.description} aria-hidden={companion ? undefined : true}>{companion?.state === 'unknown' ? '?' : companion?.state === 'disconnected' ? '−' : null}</span>
        <span className="mini__project" title={projectTitle}>{project}</span>
        <span className="mini__state" title={companion?.description}>{companion && !/Replay/.test(stateLabel) ? companion.label : stateLabel}</span>
        <span className="mini__spacer" />
        <IconButton label={pinned ? 'Unpin (stop floating on top)' : 'Keep on top'} active={pinned} onClick={onTogglePin}><PinIcon filled={pinned} /></IconButton>
        <IconButton label="Tuck into Island" onClick={onCollapse}><CollapseIcon /></IconButton>
        <IconButton label="Open full view" onClick={onExpand}><ExpandIcon /></IconButton>
      </header>
      <div className="mini__map">{children}</div>
      {footer}
      <div className="mini__resize" onPointerDown={begin('resize')} aria-hidden />
    </motion.div>
  );
};
