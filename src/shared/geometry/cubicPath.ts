import { clamp } from '../motion/easing';
import type { Vec } from './vec';

const LUT_SAMPLES = 256;

/**
 * A cubic Bézier connection with arc-length parametrization, so that "50%" means
 * half of the visible line — the same behaviour as SVG getPointAtLength in the concept.
 */
export class CubicPath {
  readonly length: number;
  private readonly cumulative: Float64Array;

  constructor(
    readonly start: Vec,
    readonly control1: Vec,
    readonly control2: Vec,
    readonly end: Vec,
  ) {
    this.cumulative = new Float64Array(LUT_SAMPLES + 1);
    let previous = start;
    let total = 0;
    for (let i = 1; i <= LUT_SAMPLES; i++) {
      const point = this.pointAtParameter(i / LUT_SAMPLES);
      total += Math.hypot(point.x - previous.x, point.y - previous.y);
      this.cumulative[i] = total;
      previous = point;
    }
    this.length = total;
  }

  /** SVG path data (`d` attribute). */
  toSvg(): string {
    const f = (v: Vec) => `${v.x},${v.y}`;
    return `M${f(this.start)} C${f(this.control1)} ${f(this.control2)} ${f(this.end)}`;
  }

  /** Point at a fraction (0–1) of the path's arc length. */
  pointAt(fraction: number): Vec {
    const target = clamp(fraction) * this.length;
    let low = 0;
    let high = LUT_SAMPLES;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.cumulative[mid] ?? 0) < target) low = mid + 1;
      else high = mid;
    }
    const index = Math.max(1, low);
    const before = this.cumulative[index - 1] ?? 0;
    const after = this.cumulative[index] ?? before;
    const segment = after - before || 1;
    const parameter = (index - 1 + (target - before) / segment) / LUT_SAMPLES;
    return this.pointAtParameter(parameter);
  }

  private pointAtParameter(s: number): Vec {
    const u = 1 - s;
    const a = u * u * u;
    const b = 3 * u * u * s;
    const c = 3 * u * s * s;
    const d = s * s * s;
    return {
      x: a * this.start.x + b * this.control1.x + c * this.control2.x + d * this.end.x,
      y: a * this.start.y + b * this.control1.y + c * this.control2.y + d * this.end.y,
    };
  }
}

/** Parses the subset of SVG path syntax used by Raio connections: `M x,y C x,y x,y x,y`. */
export const cubicFromSvg = (d: string): CubicPath => {
  const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length !== 8) throw new Error(`Expected a single cubic segment, got: ${d}`);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = numbers as [number, number, number, number, number, number, number, number];
  return new CubicPath({ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 });
};
