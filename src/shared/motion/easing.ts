/**
 * Easing and interpolation primitives used by every Raio animation.
 * Values mirror the motion concept exactly; see RAIO_MOTION_SPEC.md §1.
 */

/** Clamps `value` into [min, max]. */
export const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

/** Normalized progress (0–1) of `t` through a window starting at `start` lasting `duration` seconds. */
export const progress = (t: number, start: number, duration: number): number =>
  duration <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / duration);

/** Linear interpolation. */
export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** cubic-bezier(0.65, 0, 0.35, 1) — used for travel, camera, path reveal. */
export const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** cubic-bezier(0.33, 1, 0.68, 1) — used for activations and fades. */
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);

/** cubic-bezier(0.34, 1.56, 0.64, 1) — overshoot for settling and pill pops. */
export const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/**
 * Damped-spring impulse response e^(-6t)·sin(14t) (stiffness 232, damping 12, mass 1).
 * Returns 0 before the trigger. Peaks ≈0.50 at t≈0.09s and is visually settled by ≈0.6s.
 */
export const springBump = (secondsSinceTrigger: number): number =>
  secondsSinceTrigger <= 0 ? 0 : Math.exp(-6 * secondsSinceTrigger) * Math.sin(14 * secondsSinceTrigger);
