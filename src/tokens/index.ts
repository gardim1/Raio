import raw from './raio.tokens.json';
import type { Rgb } from '../shared/color';

/** Typed access to raio.tokens.json — the single source of visual truth. */
export const tokens = raw;

const asRgb = (value: readonly number[]): Rgb => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];

export const palette = {
  cool: asRgb(raw.color.accent.coolRgb),
  warning: asRgb(raw.color.accent.warningRgb),
  success: asRgb(raw.color.accent.successRgb),
  danger: asRgb(raw.color.accent.dangerRgb),
  neutral: asRgb(raw.color.accent.neutralRgb),
} as const;

/** Tone used by nodes, connections, pulses and pills. */
export type Tone = 'cool' | 'warning' | 'success' | 'danger';

export const toneRgb = (tone: Tone): Rgb => palette[tone];
