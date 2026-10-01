import { useCallback, useEffect, useRef, useState } from 'react';
import { frozenClock } from './frozenClock';

export interface PlaybackOptions {
  /** Seconds at which playback restarts from 0 (film). Omit to keep running. */
  readonly loopAt?: number;
  /** Seconds at which playback pauses by itself (replay end). */
  readonly stopAt?: number;
  readonly autoplay?: boolean;
  /** Respect prefers-reduced-motion by jumping to `reducedMotionAt`. */
  readonly reducedMotionAt?: number;
}

export interface Playback {
  readonly t: number;
  readonly playing: boolean;
  readonly speed: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  restart(): void;
  setSpeed(speed: number): void;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * A requestAnimationFrame clock that drives one choreography. The whole UI is a pure
 * function of `t`, so pausing, scrubbing and speed changes are free.
 */
export const usePlayback = ({ loopAt, stopAt, autoplay = true, reducedMotionAt }: PlaybackOptions = {}): Playback => {
  const frozen = frozenClock();
  const reduced = prefersReducedMotion() && reducedMotionAt !== undefined;
  const [t, setT] = useState(frozen ?? (reduced ? (reducedMotionAt ?? 0) : 0));
  const [playing, setPlaying] = useState(frozen === null && autoplay && !reduced);
  const [speed, setSpeedState] = useState(1);
  const timeRef = useRef(t);
  const lastFrame = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      lastFrame.current = null;
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const last = lastFrame.current ?? now;
      lastFrame.current = now;
      let next = timeRef.current + ((now - last) / 1000) * speed;
      if (loopAt !== undefined && next > loopAt) next = 0;
      if (stopAt !== undefined && next >= stopAt) {
        next = stopAt;
        timeRef.current = next;
        setT(next);
        setPlaying(false);
        return;
      }
      timeRef.current = next;
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, loopAt, stopAt]);

  const seek = useCallback((seconds: number) => {
    timeRef.current = Math.max(0, seconds);
    setT(timeRef.current);
  }, []);

  return {
    t,
    playing,
    speed,
    play: () => {
      if (stopAt !== undefined && timeRef.current >= stopAt) seek(0);
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    toggle: () => {
      if (!playing && stopAt !== undefined && timeRef.current >= stopAt) seek(0);
      setPlaying((p) => !p);
    },
    seek,
    restart: () => {
      seek(frozen ?? 0);
      setPlaying(frozen === null);
    },
    setSpeed: setSpeedState,
  };
};
