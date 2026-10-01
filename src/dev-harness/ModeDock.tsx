import type { DisplayMode } from '../features/session/store/sessionStore';

const MODES: readonly { readonly id: DisplayMode; readonly label: string; readonly key: string }[] = [
  { id: 'film', label: 'Concept film', key: '1' },
  { id: 'island', label: 'Island', key: '2' },
  { id: 'mini', label: 'Mini player', key: '3' },
  { id: 'expanded', label: 'Expanded', key: '4' },
  { id: 'states', label: 'States', key: '5' },
];

export interface ModeDockProps {
  readonly mode: DisplayMode;
  readonly onMode: (mode: DisplayMode) => void;
  readonly onRunLive: () => void;
  readonly onViewChanges: () => void;
}

/** Prototype-only chrome (not part of the product): switch modes, rerun the session, open the replay. */
export const ModeDock = ({ mode, onMode, onRunLive, onViewChanges }: ModeDockProps) => (
  <nav className="dock" aria-label="Prototype controls">
    <div className="dock__seg" role="tablist">
      {MODES.map((m) => (
        <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => onMode(m.id)} title={`Shortcut: ${m.key}`}>
          {m.label}
        </button>
      ))}
    </div>
    <span className="dock__sep" />
    <button className="dock__action" onClick={onRunLive}>
      Run live session
    </button>
    <button className="dock__action" onClick={onViewChanges}>
      View changes
    </button>
  </nav>
);
export { MODES };
