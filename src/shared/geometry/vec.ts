import { lerp } from '../motion/easing';

/** A 2D point in canvas world units (1000×520 space). */
export interface Vec {
  readonly x: number;
  readonly y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });

export const lerpVec = (a: Vec, b: Vec, amount: number): Vec => ({ x: lerp(a.x, b.x, amount), y: lerp(a.y, b.y, amount) });

/** Interpolates from `a` to `b` while lifting the point upward by `lift·sin(π·amount)`. */
export const arcVec = (a: Vec, b: Vec, amount: number, lift: number): Vec => {
  const p = lerpVec(a, b, amount);
  return { x: p.x, y: p.y - lift * Math.sin(Math.PI * amount) };
};

export const distance = (a: Vec, b: Vec): number => Math.hypot(b.x - a.x, b.y - a.y);
