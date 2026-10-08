import { describe, expect, it } from 'vitest';
import { CookieFlight, cookieLocalPoint, type CookieFlightPorts, type CookiePoint } from './cookieFlight';

const setup = (reduced = false) => {
  let visible = true, targetVisible = true, targetBusy = false;
  let destination: CookiePoint = { x: 200, y: 100, diameter: 20 };
  let tick: ((dt: number) => boolean) | undefined, visibility: (() => void) | undefined, done: (() => void) | undefined;
  let overlays = 0, arrivals = 0, removed = 0;
  const positions: CookiePoint[] = [];
  const ports: CookieFlightPorts = {
    visible: () => visible, reduced: () => reduced,
    origin: () => ({ x: 10, y: 20, diameter: 10 }),
    target: () => ({ busy: () => targetBusy, measure: () => targetVisible ? destination : null,
      arrive: callback => { if (targetBusy) return false; arrivals++; targetBusy = true; done = callback; return true; } }),
    overlay: () => { overlays++; return { move: point => positions.push(point), remove: () => { removed++; } }; },
    animate: callback => { tick = callback; return () => { tick = undefined; }; },
    subscribeVisibility: callback => { visibility = callback; return () => { visibility = undefined; }; },
  };
  const flight = new CookieFlight(ports);
  return { flight, positions, step: (dt: number) => tick?.(dt), finishReaction: () => { targetBusy = false; done?.(); },
    hide: () => { visible = false; visibility?.(); }, loseTarget: () => { targetVisible = false; },
    resize: (point: CookiePoint) => { destination = point; }, setBusy: () => { targetBusy = true; },
    reduce: () => { reduced = true; },
    stats: () => ({ overlays, arrivals, removed, ticking: !!tick, subscribed: !!visibility }) };
};
describe('Expanded cookie flight', () => {
  it('converts client geometry into a scaled/translated app SVG without doubling zoom', () => {
    expect(cookieLocalPoint({ x: 230, y: 140, diameter: 22 }, { a: 1.1, b: 0, c: 0, d: 1.1, e: 10, f: 30 }))
      .toEqual({ x: expect.closeTo(200), y: expect.closeTo(100), scale: expect.closeTo(2) });
    expect(cookieLocalPoint({ x: 10, y: 20, diameter: 10 }, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeNull();
  });
  it('uses the prototype .5s ease and current destination, then removes the overlay before one arrival', () => {
    const f = setup();
    expect(f.flight.start()).toBe(true);
    expect(f.flight.start()).toBe(false);
    f.step(.25);
    expect(f.positions.at(-1)).toEqual({ x: 105, y: 60, diameter: 15 });
    expect(f.stats().arrivals).toBe(0);
    f.resize({ x: 400, y: 300, diameter: 30 });
    expect(f.step(.25)).toBe(true); // one final wake lets the existing engine start its reaction
    expect(f.positions.at(-1)).toEqual({ x: 400, y: 300, diameter: 30 });
    expect(f.stats()).toEqual({ overlays: 1, arrivals: 1, removed: 1, ticking: false, subscribed: true });
    expect(f.flight.start()).toBe(false);
    f.finishReaction();
    expect(f.flight.busy).toBe(false);
    expect(f.stats().subscribed).toBe(false);
    expect(f.flight.start()).toBe(true);
  });
  it('ignores a busy target without creating or queuing a flight', () => {
    const f = setup(); f.setBusy();
    expect(f.flight.start()).toBe(false);
    expect(f.stats()).toEqual({ overlays: 0, arrivals: 0, removed: 0, ticking: false, subscribed: false });
  });
  it.each(['hidden', 'removed target', 'unmount'] as const)('cancels on %s without orphan nodes or a delayed arrival', reason => {
    const f = setup(); f.flight.start(); f.step(.2);
    if (reason === 'hidden') f.hide();
    if (reason === 'removed target') { f.loseTarget(); f.step(.3); }
    if (reason === 'unmount') f.flight.cancel();
    f.step(1); f.flight.cancel();
    expect(f.flight.busy).toBe(false);
    expect(f.stats()).toEqual({ overlays: 1, arrivals: 0, removed: 1, ticking: false, subscribed: false });
  });
  it('reduced motion skips the overlay and flight clock, retaining the targeted reaction', () => {
    const f = setup(true);
    expect(f.flight.start()).toBe(true);
    expect(f.stats()).toEqual({ overlays: 0, arrivals: 1, removed: 0, ticking: false, subscribed: true });
    expect(f.flight.start()).toBe(false);
    f.finishReaction();
    expect(f.flight.busy).toBe(false);
  });
  it('switches to the approved reduced branch if the preference changes during flight', () => {
    const f = setup(); f.flight.start(); f.step(.2); f.reduce(); f.step(.01);
    expect(f.stats()).toEqual({ overlays: 1, arrivals: 1, removed: 1, ticking: false, subscribed: true });
    f.finishReaction();
    expect(f.flight.busy).toBe(false);
  });
  it('does not queue a reaction if the target becomes busy during flight', () => {
    const f = setup(); f.flight.start(); f.setBusy(); f.step(.5);
    expect(f.stats().arrivals).toBe(0);
    expect(f.stats().removed).toBe(1);
    expect(f.flight.busy).toBe(false);
  });
});
