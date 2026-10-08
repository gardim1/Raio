import type { SyntheticEvent } from 'react';
import type { CompanionPresence } from './companionPresence';
import { MiniOrb } from '../raio/MiniOrb';

// Bubble only: the character's native body handlers receive the gesture first.
// Guard the rest of its slot too, so the ancestor disclosure never activates or takes focus.
const containGesture = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };

export const IslandCharacter = ({ companion, title }: {
  readonly companion?: CompanionPresence;
  readonly title?: string;
}) => <span className="island__character" title={title}
  onPointerDown={containGesture} onClick={containGesture} onDoubleClick={containGesture}>
  <MiniOrb companion={companion} size={14} />
</span>;
