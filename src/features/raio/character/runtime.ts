import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../../shared/motion/surfaceVisibility';
import type { CharacterEngine } from './engine';
import type { CharacterReaction } from './types';

interface AnimatedCharacter {
  update(dt: number): boolean;
  sense(x: number, y: number): void;
  leave(): void;
  react(kind: CharacterReaction, side?: number): void;
  reconcileReducedMotion?(): void;
}
interface LoopPorts {
  now(): number;
  request(fn: FrameRequestCallback): number;
  cancel(id: number): void;
  visible(): boolean;
  subscribeVisibility(fn: () => void): () => void;
  subscribePointer(move: (x: number, y: number) => void, leave: () => void): () => void;
}
/** One shared frame and visible-only pointer subscription, not one loop per drawing. */
export class CharacterLoop {
  private readonly characters = new Set<AnimatedCharacter>();
  private raf: number | undefined;
  private last = 0;
  private ticking = false;
  private manual = false;
  private stopVisibility: (() => void) | undefined;
  private stopPointer: (() => void) | undefined;
  constructor(private readonly ports: LoopPorts) {}
  readonly wake = () => {
    if (this.manual || this.ticking || this.raf !== undefined || !this.characters.size || !this.ports.visible()) return;
    this.last = this.ports.now(); this.raf = this.ports.request(this.tick);
  };
  private readonly tick = (now: number) => {
    this.ticking = true;
    const busy = this.step(Math.min(.05, Math.max(0, (now - this.last) / 1000)));
    this.ticking = false; this.last = now; this.raf = undefined;
    if (busy && this.ports.visible() && !this.manual) this.raf = this.ports.request(this.tick);
  };
  private step(dt: number) { let busy = false; this.characters.forEach(c => { busy = c.update(dt) || busy; }); return busy; }
  private cancel() { if (this.raf !== undefined) this.ports.cancel(this.raf); this.raf = undefined; }
  private readonly visibility = () => {
    this.stopPointer?.(); this.stopPointer = undefined;
    if (!this.ports.visible()) { this.cancel(); this.characters.forEach(c => c.leave()); return; }
    this.stopPointer = this.ports.subscribePointer((x, y) => this.characters.forEach(c => c.sense(x, y)), () => this.characters.forEach(c => c.leave()));
    this.wake();
  };
  add(character: AnimatedCharacter): () => void {
    this.characters.add(character);
    if (this.characters.size === 1) { this.stopVisibility = this.ports.subscribeVisibility(this.visibility); this.visibility(); }
    this.wake();
    return () => {
      this.characters.delete(character);
      if (!this.characters.size) { this.cancel(); this.stopPointer?.(); this.stopPointer = undefined; this.stopVisibility?.(); this.stopVisibility = undefined; }
    };
  }
  react(kind: CharacterReaction) {
    if (!this.ports.visible()) return;
    this.characters.forEach(c => c.react(kind)); this.wake();
  }
  reconcileReducedMotion() { this.characters.forEach(c => c.reconcileReducedMotion?.()); this.wake(); }
  setManual(value: boolean) { this.manual = value; if (value) this.cancel(); else this.wake(); }
  /** Deterministic 60 Hz stepping; no wall-time timers. Hidden surfaces remain paused. */
  advance(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || !this.ports.visible()) return;
    for (let t = 0; t < seconds - 1e-8; t += 1 / 60) this.step(Math.min(1 / 60, seconds - t));
  }
}

let runtime: CharacterLoop | undefined;
let media: MediaQueryList | undefined;
let reducedOverride: boolean | undefined;
let mediaUsers = 0;
let randomOverride: (() => number) | undefined;
let frozenSeconds: number | null = null;
export const characterRandom = () => (randomOverride ?? Math.random)();
export const setCharacterRandom = (value: (() => number) | undefined) => { randomOverride = value; };
/** Clock seam used by deterministic renderer fixtures; product never configures it. */
export const setCharacterFrozenTime = (seconds: number | null) => {
  frozenSeconds = seconds !== null && Number.isFinite(seconds) ? Math.max(0, seconds) : null;
  characterLoop().setManual(frozenSeconds !== null);
};
export const initializeCharacterFrame = (engine: Pick<CharacterEngine, 'update'>) => {
  if (frozenSeconds === null || !isSurfaceVisible()) return;
  for (let t = 0; t < frozenSeconds - 1e-8; t += 1 / 60) engine.update(Math.min(1 / 60, frozenSeconds - t));
};
const mediaChange = () => runtime?.reconcileReducedMotion();
export const characterReducedMotion = () => reducedOverride ?? media?.matches ?? false;
export const setCharacterReducedMotion = (value: boolean | undefined) => { reducedOverride = value; runtime?.reconcileReducedMotion(); };
export const characterLoop = (): CharacterLoop => runtime ??= new CharacterLoop({
  now: () => performance.now(), request: fn => requestAnimationFrame(fn), cancel: id => cancelAnimationFrame(id),
  visible: isSurfaceVisible, subscribeVisibility: subscribeSurfaceVisibility,
  subscribePointer: (move, leave) => {
    const pointer = (e: PointerEvent) => move(e.clientX, e.clientY);
    window.addEventListener('pointermove', pointer, { passive: true }); document.addEventListener('pointerleave', leave);
    return () => { window.removeEventListener('pointermove', pointer); document.removeEventListener('pointerleave', leave); };
  },
});
export const mountCharacter = (engine: CharacterEngine): (() => void) => {
  if (mediaUsers++ === 0 && typeof matchMedia !== 'undefined') { media = matchMedia('(prefers-reduced-motion: reduce)'); media.addEventListener('change', mediaChange); }
  const stop = characterLoop().add(engine);
  return () => { stop(); engine.dispose(); if (--mediaUsers === 0) { media?.removeEventListener('change', mediaChange); media = undefined; } };
};
export const requestCharacterReaction = (kind: CharacterReaction): void => { runtime?.react(kind); };

/** SVGs do not receive focus; cancelling the default also prevents a focusable ancestor taking it. */
export const bindCharacterInteraction = (engine: CharacterEngine, now = () => performance.now()): (() => void) => {
  let clicks: number[] = [];
  const down = (event: Event) => {
    event.stopPropagation(); event.preventDefault();
    const e = event as PointerEvent, r = engine.svg.getBoundingClientRect(), at = now();
    const matrix = engine.svg.getScreenCTM?.();
    const side = Math.sign(e.clientX - (matrix?.e ?? r.left + r.width / 2));
    clicks = clicks.filter(t => at - t <= 1300); clicks.push(at);
    if (clicks.length >= 4) { clicks = []; engine.react('dizzy'); } else engine.react('click', side);
  };
  const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  engine.hit.setAttribute('style', 'cursor:pointer');
  engine.hit.addEventListener('pointerdown', down); engine.hit.addEventListener('click', swallow); engine.hit.addEventListener('dblclick', swallow);
  return () => { clicks = []; engine.hit.removeEventListener('pointerdown', down); engine.hit.removeEventListener('click', swallow); engine.hit.removeEventListener('dblclick', swallow); };
};
