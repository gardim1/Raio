import { useId, useState } from 'react';

export const AboutMap = ({ details, technologies = [] }: { readonly details: readonly string[]; readonly technologies?: readonly string[] }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="map-about">
    <span className="map-about__cue">Heuristic map</span>
    <button type="button" className="map-about__toggle" aria-expanded={open} aria-controls={id}
      onKeyDown={event => { if (event.key === ' ') event.stopPropagation(); }}
      onClick={() => setOpen(value => !value)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" /><path d="M8 7v5M8 4v1" stroke="currentColor" /></svg>
      About this map
    </button>
    <div id={id} hidden={!open}>
      {details.map(line => <p className="evidence__note" key={line}>{line}</p>)}
      {technologies.length > 0 && <ul className="evidence__list" aria-label="Technology hints">{technologies.map(line => <li className="evidence__item" key={line}>
        <span className="evidence__path" title={line}>{line}</span><span className="evidence__meta">named in manifests (names only, heuristic)</span>
      </li>)}</ul>}
    </div>
  </div>;
};
