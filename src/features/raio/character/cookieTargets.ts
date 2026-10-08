import type { CharacterEngine } from './engine';
import type { CookieTarget } from '../cookieFlight';

const engines = new Set<CharacterEngine>();
export const registerCookieTarget = (engine: CharacterEngine) => {
  engines.add(engine);
  return () => { engines.delete(engine); };
};

/** Client geometry, clipped to this window and every clipping ancestor, including the map viewport. */
const measure = (engine: CharacterEngine, scope: Element) => {
  if (!engines.has(engine) || !engine.svg.isConnected || !scope.contains(engine.svg)) return null;
  const body = engine.gBody.getBoundingClientRect(), matrix = engine.svg.getScreenCTM();
  if (!matrix || body.width <= 0 || body.height <= 0) return null;
  const view = engine.svg.ownerDocument.defaultView;
  if (!view) return null;
  let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
  for (let el: Element | null = engine.svg; el; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
  }
  if (body.left < left || body.right > right || body.top < top || body.bottom > bottom) return null;
  // The approved cookie reaches (0, 4.5) in the engine's gFx coordinates.
  return { x: matrix.e + matrix.c * 4.5, y: matrix.f + matrix.d * 4.5, diameter: Math.hypot(matrix.a, matrix.b) * 10 };
};
export const findCookieTarget = (scope: Element): CookieTarget | undefined => {
  const candidates = [...engines].filter(engine => scope.contains(engine.svg));
  const engine = candidates.find(candidate => candidate.size === 'map' && candidate.svg.closest('.expanded__map') && measure(candidate, scope))
    ?? candidates.find(candidate => candidate.svg.closest('.titlebar__brand') && measure(candidate, scope));
  return engine ? { measure: () => measure(engine, scope), busy: () => engine.busyWith !== null, arrive: done => engine.cookieArrived(done) } : undefined;
};
