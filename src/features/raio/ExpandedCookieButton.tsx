import { useEffect, useRef } from 'react';
import { IconButton } from '../../shared/ui/Button';
import { isSurfaceVisible, subscribeSurfaceVisibility } from '../../shared/motion/surfaceVisibility';
import { CookieFlight, cookieLocalPoint } from './cookieFlight';
import { findCookieTarget } from './character/cookieTargets';
import { characterLoop, characterReducedMotion } from './character/runtime';

const NS = 'http://www.w3.org/2000/svg';
const createFlight = (button: HTMLButtonElement, scope: Element, surface: Element) => new CookieFlight({
  visible: isSurfaceVisible, reduced: characterReducedMotion, subscribeVisibility: subscribeSurfaceVisibility,
  target: () => findCookieTarget(scope),
  origin: () => { const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, diameter: 10 }; },
  animate: update => characterLoop().add({ update, sense() {}, leave() {}, react() {} }),
  overlay: () => {
    const svg = button.ownerDocument.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'cookie-flight');
    const drawing = button.ownerDocument.createElementNS(NS, 'g');
    drawing.setAttribute('class', 'cookie-flight__drawing'); svg.appendChild(drawing);
    const circle = (attrs: Record<string, string | number>) => {
      const el = button.ownerDocument.createElementNS(NS, 'circle');
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      drawing.appendChild(el);
    };
    circle({ r: 5, fill: '#d9a066' }); circle({ r: 5, fill: 'none', stroke: '#b9824c', 'stroke-width': .6 });
    [[-1.8, -1.2], [1.6, -.6], [-.2, 1.8], [1.9, 2]].forEach(([cx, cy]) => circle({ cx: cx!, cy: cy!, r: .75, fill: '#5e3b22' }));
    surface.appendChild(svg);
    return { move: point => {
      const matrix = svg.getScreenCTM(), local = matrix && cookieLocalPoint(point, matrix);
      if (local) drawing.setAttribute('transform', `translate(${local.x} ${local.y}) scale(${local.scale})`);
    }, remove: () => svg.remove() };
  },
});

export const ExpandedCookieButton = () => {
  const flight = useRef<CookieFlight | undefined>(undefined);
  useEffect(() => () => flight.current?.cancel(), []);
  return <IconButton label="Give Raio a cookie" className="cookie-button" onKeyDown={event => {
    if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
  }} onClick={event => {
    const button = event.currentTarget, scope = button.closest('.expanded'), surface = button.closest('.app') ?? button.closest('.expanded-dock');
    if (!scope || !surface) return;
    flight.current ??= createFlight(button, scope, surface);
    flight.current.start();
  }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M20 12.5a8 8 0 1 1-8.5-8.5 4 4 0 0 0 4 4 4 4 0 0 0 4.5 4.5Z" />
      <circle cx="9" cy="10" r=".8" fill="currentColor" /><circle cx="8" cy="15" r=".8" fill="currentColor" /><circle cx="14" cy="16" r=".8" fill="currentColor" />
    </svg>
  </IconButton>;
};
