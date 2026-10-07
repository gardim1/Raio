import type { CompanionPresence } from './companionPresence';
import { MiniOrb } from '../raio/MiniOrb';

/** The Island when there is no session to show: the collapsed capsule only; a click opens Raio. */
export const IdleIsland = ({ onOpen, companion }: { readonly onOpen: () => void; readonly companion?: CompanionPresence }) => (
  <div className="island-dock">
    <button type="button" className="island island--idle" style={{ borderRadius: 17 }} onClick={onOpen} aria-label={companion ? `Raio: ${companion.description}. Open Raio` : 'Raio: no session. Open Raio'} title={companion?.description}>
      <span className="island__closed">
        <MiniOrb companion={companion} size={14} glow={0.25} />
        <span className="island__label">{companion?.state === 'unknown' ? '? ' : companion?.state === 'disconnected' ? '− ' : ''}{companion?.label ?? 'Raio · no session'}</span>
        <i data-presence={companion?.state} className="island__dot island__dot--idle" />
      </span>
    </button>
  </div>
);
