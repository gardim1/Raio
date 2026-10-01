import type { Playback } from '../../shared/motion/usePlayback';
import { IconButton } from '../../shared/ui/Button';
import { CloseIcon, PauseIcon, PlayIcon, ReplayIcon } from '../../shared/ui/icons';
import type { ChoreographyScript, StoryEvent } from '../session/model/script';

const SPEEDS = [1, 2, 0.5] as const;

export interface ReplayControlsProps {
  readonly script: ChoreographyScript;
  readonly playback: Playback;
  readonly compact?: boolean;
  readonly onInspect?: (event: StoryEvent) => void;
  readonly onExit?: () => void;
}

/** Play/Pause · Replay · speed · scrubber with event ticks. Deliberately not a video editor. */
export const ReplayControls = ({ script, playback, compact = false, onInspect, onExit }: ReplayControlsProps) => {
  const end = script.duration;
  const fraction = Math.min(1, playback.t / end);
  const seekTo = (clientX: number, rect: DOMRect) => playback.seek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * end);
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(playback.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length] ?? 1;

  return (
    <div className={`replay${compact ? ' replay--compact' : ''}`}>
      <IconButton label={playback.playing ? 'Pause replay' : 'Play replay'} onClick={playback.toggle}>
        {playback.playing ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
      {!compact && (
        <IconButton label="Replay from start" onClick={playback.restart}>
          <ReplayIcon />
        </IconButton>
      )}
      <div
        className="replay__track"
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(end * 10) / 10}
        aria-valuenow={Math.round(playback.t * 10) / 10}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seekTo(e.clientX, rect);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => e.buttons === 1 && seekTo(e.clientX, e.currentTarget.getBoundingClientRect())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') playback.seek(Math.min(end, playback.t + 0.5));
          if (e.key === 'ArrowLeft') playback.seek(Math.max(0, playback.t - 0.5));
        }}
      >
        <i className="replay__fill" style={{ width: `${fraction * 100}%` }} />
        {script.story.map((ev, i) => (
          <button
            key={i}
            type="button"
            className={`replay__tick replay__tick--${ev.tone}`}
            style={{ left: `${(ev.t / end) * 100}%` }}
            aria-label={`${ev.label} at ${ev.realTime ?? ''}`}
            title={ev.label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              playback.seek(ev.t);
              onInspect?.(ev);
            }}
          />
        ))}
      </div>
      {!compact && (
        <button type="button" className="replay__speed" onClick={() => playback.setSpeed(nextSpeed)} aria-label="Playback speed">
          {playback.speed}×
        </button>
      )}
      {onExit && (
        <IconButton label="Close replay" onClick={onExit}>
          <CloseIcon />
        </IconButton>
      )}
    </div>
  );
};
