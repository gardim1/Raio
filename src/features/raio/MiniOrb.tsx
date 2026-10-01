import type { CSSProperties } from 'react';

export interface MiniOrbProps {
  /** Diameter in px (brand mark 12, island 14–18, wordmark 18). */
  readonly size?: number;
  /** 0–1 glow intensity; follow the live orb's working level. */
  readonly glow?: number;
  readonly warm?: number;
  readonly bob?: boolean;
}

/** CSS rendition of Raio used in chrome (title bar, Island, wordmark). */
export const MiniOrb = ({ size = 12, glow = 0.55, warm = 0, bob = false }: MiniOrbProps) => {
  const style: CSSProperties = {
    width: size,
    height: size,
    boxShadow: `0 0 ${Math.round(size * 0.85)}px rgba(${Math.round(138 + 107 * warm)},${Math.round(180 + 2 * warm)},${Math.round(255 - 163 * warm)},${glow.toFixed(2)})`,
  };
  return <span className={`mini-orb${bob ? ' mini-orb--bob' : ''}`} style={style} aria-hidden />;
};
