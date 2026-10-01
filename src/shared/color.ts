/** RGB triple (0–255). */
export type Rgb = readonly [number, number, number];

export const mixRgb = (a: Rgb, b: Rgb, amount: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * amount),
  Math.round(a[1] + (b[1] - a[1]) * amount),
  Math.round(a[2] + (b[2] - a[2]) * amount),
];

export const rgba = (color: Rgb, alpha: number): string =>
  `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
