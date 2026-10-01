import { describe, expect, it } from 'vitest';
import { CubicPath, cubicFromSvg } from './cubicPath';

describe('CubicPath', () => {
  it('starts and ends at its endpoints', () => {
    const path = cubicFromSvg('M236,280 C282,280 278,150 324,150');
    expect(path.pointAt(0)).toEqual({ x: 236, y: 280 });
    const end = path.pointAt(1);
    expect(end.x).toBeCloseTo(324, 6);
    expect(end.y).toBeCloseTo(150, 6);
  });

  it('is parametrized by arc length (a straight cubic moves linearly)', () => {
    const line = new CubicPath({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 });
    expect(line.length).toBeCloseTo(100, 3);
    expect(line.pointAt(0.25).x).toBeCloseTo(25, 1);
    expect(line.pointAt(0.5).x).toBeCloseTo(50, 1);
  });

  it('round-trips to SVG path data', () => {
    expect(cubicFromSvg('M1,2 C3,4 5,6 7,8').toSvg()).toBe('M1,2 C3,4 5,6 7,8');
  });
});
