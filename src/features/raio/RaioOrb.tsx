import type { CompanionPresence } from '../modes/companionPresence';
import type { OrbFrame, UiFrame } from '../session/model/evaluateFrame';
import { useSessionUi } from '../session/store/sessionStore';
import { CharacterDrawing } from './character/RaioCharacter';
import { replayCharacterMode } from './character/mood';
import { useCharacterMood } from './character/useCharacterMood';

export interface RaioOrbProps {
  readonly frame: OrbFrame;
  /** Retained for callers; the character owns unique gradient ids. */
  readonly idPrefix: string;
  readonly sizeMultiplier?: number;
  readonly ui?: Pick<UiFrame, 'status' | 'activeRisk'>;
  readonly companion?: CompanionPresence;
}

/** Preserve map travel, scale, opacity and layering; draw only the approved character. */
export const RaioOrb = ({ frame, sizeMultiplier = 1, ui, companion }: RaioOrbProps) => {
  const replay = useSessionUi(s => s.source === 'replay');
  const live = useCharacterMood(companion, { replay });
  const mode = replay && ui ? replayCharacterMode(ui) : live;
  return <g className="raio-orb" transform={`translate(${frame.position.x.toFixed(2)} ${frame.position.y.toFixed(2)}) scale(${(frame.scale * sizeMultiplier).toFixed(4)})`} opacity={frame.opacity} aria-label="Raio">
    <CharacterDrawing size="map" mode={mode} />
  </g>;
};

/** Compatibility export; gradients now live with each character, including group hosts. */
export const RaioDefs = (_props: { readonly idPrefix: string }) => null;
