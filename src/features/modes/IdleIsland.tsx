import { MiniOrb } from '../raio/MiniOrb';

/** The Island when there is no session to show: the collapsed capsule only; a click opens Raio. */
export const IdleIsland = ({ onOpen }: { readonly onOpen: () => void }) => (
  <div className="island-dock">
    <button type="button" className="island island--idle" style={{ borderRadius: 17 }} onClick={onOpen} aria-label="Raio: no session. Open Raio">
      <span className="island__closed">
        <MiniOrb size={14} glow={0.25} bob />
        <span className="island__label">Raio · no session</span>
        <i className="island__dot island__dot--idle" />
      </span>
    </button>
  </div>
);
