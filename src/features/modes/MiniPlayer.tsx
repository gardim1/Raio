import { motion } from 'motion/react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import { clamp } from '../../shared/motion/easing';
import { Button, IconButton } from '../../shared/ui/Button';
import { CollapseIcon, ExpandIcon, PinIcon, PlayIcon } from '../../shared/ui/icons';
import { tokens } from '../../tokens';
import { ArchitectureCanvas } from '../architecture/components/ArchitectureCanvas';
import type { ArchitectureGraph } from '../architecture/model/types';
import { statusLabel } from '../../shared/ui/AgentStatus';
import type { FrameState } from '../session/model/evaluateFrame';
import type { ChoreographyScript } from '../session/model/script';
import { MORPH_TRANSITION, type Presence } from './presence';

const SIZE = tokens.size.miniPlayer;

export interface MiniPlayerProps {
  readonly script: ChoreographyScript;
  readonly frame: FrameState;
  readonly graph: ArchitectureGraph;
  readonly project: string;
  readonly presence: Presence;
  readonly pinned: boolean;
  readonly replay?: ReactNode;
  /** Overrides the header state text (e.g. "Replay"). */
  readonly stateLabel?: string;
  readonly onTogglePin: () => void;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onViewChanges: () => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const initialRect = (): Rect => ({
  w: SIZE.width,
  h: SIZE.height,
  x: Math.max(16, window.innerWidth - SIZE.width - 28),
  y: Math.max(16, window.innerHeight - SIZE.height - 104),
});

/**
 * Mini Player — a calm picture-in-picture window (380×250 default; 300–560 × 200–380).
 * Drag by the header, resize from the corner; optionally always-on-top (pin).
 */
export const MiniPlayer = ({ script, frame, graph, project, presence, pinned, replay, stateLabel, onTogglePin, onExpand, onCollapse, onViewChanges }: MiniPlayerProps) => {
  const [rect, setRect] = useState<Rect>(initialRect);
  const gesture = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origin: Rect } | null>(null);

  const begin = useCallback(
    (kind: 'move' | 'resize') => (e: ReactPointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      gesture.current = { kind, startX: e.clientX, startY: e.clientY, origin: rect };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [rect],
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

  const { ui } = frame;
  return (
    <motion.div
      layoutId="raio-surface"
      layoutDependency={`${rect.w}x${rect.h}`}
      transition={MORPH_TRANSITION}
      className="mini"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: 20 }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <header className="mini__head" onPointerDown={begin('move')}>
        <span className={`mini__status mini__status--${ui.status}`} />
        <span className="mini__project">{project}</span>
        <span className="mini__state">{stateLabel ?? statusLabel(ui.status, script.agent)}</span>
        <span className="mini__spacer" />
        <IconButton label={pinned ? 'Unpin (stop floating on top)' : 'Keep on top'} active={pinned} onClick={onTogglePin}>
          <PinIcon filled={pinned} />
        </IconButton>
        <IconButton label="Tuck into Island" onClick={onCollapse}>
          <CollapseIcon />
        </IconButton>
        <IconButton label="Open full view" onClick={onExpand}>
          <ExpandIcon />
        </IconButton>
      </header>
      <div className="mini__map">
        <ArchitectureCanvas graph={graph} frame={frame} variant="mini" camera={false} fit="content" className="mini__svg" />
        {ui.activeRisk && (
          <span className="mini__risk" style={{ opacity: frame.risks[0]?.pill.opacity ?? 1 }}>
            <i />
            {ui.activeRisk.label}
          </span>
        )}
      </div>
      {replay ? (
        <div className="mini__foot">{replay}</div>
      ) : presence.cta !== 'hidden' ? (
        <div className="mini__foot">
          <span className="mini__foot-text">
            {script.summary.systems} systems, {script.summary.reviewCount} to review
          </span>
          <Button className={presence.cta === 'quiet' ? 'btn--quiet' : ''} icon={<PlayIcon />} onClick={onViewChanges}>
            View changes
          </Button>
        </div>
      ) : null}
      <div className="mini__resize" onPointerDown={begin('resize')} aria-hidden />
    </motion.div>
  );
};
