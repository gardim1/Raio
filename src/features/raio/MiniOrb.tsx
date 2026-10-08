import type { CSSProperties } from 'react';
import type { CompanionPresence } from '../modes/companionPresence';
import { useSessionUi } from '../session/store/sessionStore';
import { RaioCharacter, useCharacterMood } from './character';

export interface MiniOrbProps {
  readonly companion?: CompanionPresence;
  /** Diameter in px (brand mark 12, island 14–18, wordmark 18). */
  readonly size?: number;
  /** Legacy drawing props retained for callers; presence now owns the glow. */
  readonly glow?: number;
  readonly warm?: number;
  /** Legacy compatibility only. The approved character rests quietly. */
  readonly bob?: boolean;
  /** Legacy compatibility only; changing this key does not remount the character. */
  readonly restartKey?: string;
}

/** Body-sized drag exclusion wrapper; the SVG box is twice the body diameter. */
export const MiniOrb = ({ size = 12, companion }: MiniOrbProps) => {
  const replay = useSessionUi(s => s.source === 'replay');
  const mode = useCharacterMood(companion, { replay });
  const style: CSSProperties = {
    width: size,
    height: size,
    '--raio-char-box': `${size * 2}px`,
  } as CSSProperties;
  return <span className="mini-orb" data-character data-presence={companion?.state} style={style} aria-hidden><RaioCharacter size="island" mode={mode} interactive /></span>;
};
