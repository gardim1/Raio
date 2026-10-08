import { describe, expect, it, vi } from 'vitest';
import { CharacterEngine, Spring } from './engine';

// A minimal SVG tree: exercise the actual engine's drawing/cleanup without a browser or DOM dependency.
class SvgNode {
  readonly attrs: Record<string, string> = {};
  readonly children: SvgNode[] = [];
  parent: SvgNode | undefined;
  readonly ownerDocument = { createElementNS: (_ns: string, tag: string) => new SvgNode(tag) };
  constructor(readonly tag = 'svg') {}
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
  appendChild(node: SvgNode) { node.parent = this; this.children.push(node); return node; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 44, height: 44 }; }
}
const make = (reduced = false) => {
  const root = new SvgNode();
  const engine = new CharacterEngine(root as unknown as SVGSVGElement, 'map', { reduced: () => reduced, wake: () => {}, random: () => .5 });
  return { root, engine };
};
const advance = (engine: CharacterEngine, seconds: number) => {
  for (let t = 0; t < seconds - 1e-8; t += 1 / 60) engine.update(Math.min(1 / 60, seconds - t));
};
describe('approved variant A engine', () => {
  it('starts an external cookie at arrival, then retains the approved bites, hearts and recovery', () => {
    const { engine } = make();
    engine.setMode('attention');
    const done = vi.fn();
    expect(engine.cookieArrived(done)).toBe(true);
    expect(engine.particleCount).toBe(1);
    expect((engine.gFx as unknown as SvgNode).children[0]?.attrs.transform).toBe('translate(0 4.5) scale(1)');
    advance(engine, .04);
    expect(engine.particleCount).toBe(1);
    advance(engine, .03);
    expect(engine.particleCount).toBe(4);
    advance(engine, .25);
    expect(engine.particleCount).toBe(7);
    advance(engine, .2);
    expect(engine.ex.happy.t).toBe(1);
    expect(engine.cookieArrived()).toBe(false);
    engine.react('round');
    expect(engine.busyWith).toBe('cookie');
    advance(engine, 1.29);
    expect(done).toHaveBeenCalledTimes(1);
    expect(engine.busyWith).toBeNull();
    expect(engine.mode).toBe('attention');
    expect(engine.gy.t).toBe(1.3);
    advance(engine, 2);
    expect(engine.particleCount).toBe(0);
    expect(engine.effectCount).toBe(0);
    expect(engine.update(1 / 60)).toBe(false);
  });
  it('external cookies use the unshifted REDUCED branch and release the caller on disposal', () => {
    const { engine } = make(true);
    const done = vi.fn();
    engine.cookieArrived(done);
    advance(engine, .7);
    expect(engine.particleCount).toBe(1);
    expect(engine.ex.happy.t).toBe(0);
    advance(engine, .12);
    expect(engine.particleCount).toBe(2);
    expect(engine.sx.x).toBe(1);
    engine.dispose();
    expect(done).toHaveBeenCalledTimes(1);
    expect(engine.particleCount).toBe(0);
    expect(engine.cookieArrived()).toBe(false);
    engine.dispose();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('ignores external cookies during another reaction without scheduling a queue', () => {
    const { engine } = make();
    engine.react('dizzy');
    const done = vi.fn();
    expect(engine.cookieArrived(done)).toBe(false);
    advance(engine, 5);
    expect(engine.busyWith).toBeNull();
    expect(engine.particleCount).toBe(0);
    expect(done).not.toHaveBeenCalled();
  });
  it('keeps arrival completions attached to their own effect across a reduced-motion interrupt', () => {
    let reduced = false;
    const root = new SvgNode();
    const engine = new CharacterEngine(root as unknown as SVGSVGElement, 'map', { reduced: () => reduced, wake() {}, random: () => .5 });
    const first = vi.fn(), second = vi.fn();
    engine.cookieArrived(first); advance(engine, .1);
    reduced = true; engine.react('dizzy'); advance(engine, 1.21);
    expect(engine.cookieArrived(second)).toBe(true);
    advance(engine, .5);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    engine.dispose();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('integrates the reference spring and settles with its original tolerance', () => {
    const spring = new Spring(1, 520, 16);
    spring.x = .85;
    spring.step(1 / 60);
    expect(spring.v).toBeCloseTo(1.3);
    expect(spring.x).toBeCloseTo(.8716666667);
    for (let i = 0; i < 180; i++) spring.step(1 / 60);
    expect(spring.busy).toBe(false);
    spring.snap();
    expect([spring.x, spring.v]).toEqual([1, 0]);
  });
  it('rests without blinking, floating or retaining effect nodes', () => {
    const { engine } = make();
    expect(engine.update(1 / 60)).toBe(false);
    engine.react('click', 1);
    expect(engine.sx.x).toBe(1.12);
    expect(engine.ex.closed.t).toBe(1);
    advance(engine, .15);
    expect(engine.ex.normal.t).toBe(1);
    advance(engine, 3);
    expect(engine.update(1 / 60)).toBe(false);
    expect(engine.effectCount).toBe(0);
    expect(engine.timerCount).toBe(0);
    expect(engine.particleCount).toBe(0);
  });
  it('uses unique gradients and only large characters have eye glints', () => {
    const a = make().engine, b = make().engine;
    expect(a.id).not.toBe(b.id);
    expect(a.cL).toBeUndefined();
    const root = new SvgNode();
    const big = new CharacterEngine(root as unknown as SVGSVGElement, 'big', { reduced: () => false, wake: () => {}, random: () => .5 });
    expect(big.cL).toBeDefined();
  });
  it('orbits and blinks only while working, then settles', () => {
    const { engine } = make();
    engine.setMode('working');
    const angle = engine.orbA;
    advance(engine, 2.5);
    expect(engine.orbA).toBeCloseTo(angle + 2.5 * 1.25);
    expect(engine.open.x).toBeLessThan(1);
    expect(engine.update(1 / 60)).toBe(true);
    engine.setMode('idle');
    advance(engine, 4);
    expect(engine.update(1 / 60)).toBe(false);
    expect(engine.sparks.every(s => s.s.t === 0)).toBe(true);
  });
  it('does not extend dizzy, blocks clicks, and recovers after 2.35 seconds', () => {
    const { engine } = make();
    engine.react('dizzy');
    advance(engine, 1);
    const effects = engine.effectCount;
    engine.react('dizzy'); engine.react('click', 1); engine.react('cookie'); engine.react('round');
    expect(engine.effectCount).toBe(effects);
    expect(engine.ex.dizzy.t).toBe(1);
    advance(engine, 1.36);
    expect(engine.busyWith).toBeNull();
    advance(engine, 3);
    expect(engine.update(1 / 60)).toBe(false);
  });
  it('keeps cookie/round mutually exclusive, bounds particles, and removes all crumbs/hearts', () => {
    const { engine } = make();
    engine.react('cookie'); engine.react('cookie'); engine.react('round');
    expect(engine.busyWith).toBe('cookie');
    expect(engine.particleCount).toBe(1);
    advance(engine, .57);
    expect(engine.particleCount).toBe(4); // cookie + first three crumbs
    advance(engine, .26);
    expect(engine.particleCount).toBe(7); // two bites, three crumbs each (prototype)
    advance(engine, 2.3);
    expect(engine.busyWith).toBeNull();
    expect(engine.particleCount).toBe(0);
    expect(engine.timerCount).toBe(0);
    expect(engine.effectCount).toBe(0);
    engine.react('round'); engine.react('cookie');
    expect(engine.busyWith).toBe('round');
    advance(engine, 1.92);
    expect(engine.busyWith).toBeNull();
  });
  it('bounds a celebration burst to seven confetti, removed at 1.1 seconds', () => {
    const { engine } = make();
    engine.react('celebrate'); engine.react('celebrate');
    expect(engine.particleCount).toBe(7);
    advance(engine, 1.12);
    expect(engine.particleCount).toBe(0);
    advance(engine, 2);
    expect(engine.effectCount).toBe(0);
  });
  it('an older cookie ending cannot release a newer dizzy lock or erase the failure mood', () => {
    const { engine } = make();
    engine.setMode('failure'); engine.react('cookie'); advance(engine, 1.5);
    engine.react('dizzy'); advance(engine, .82);
    expect(engine.busyWith).toBe('dizzy');
    engine.react('click'); expect(engine.ex.closed.t).toBe(0);
    advance(engine, 1.6);
    expect(engine.busyWith).toBeNull(); expect(engine.sy.t).toBe(.97); expect(engine.gy.t).toBe(1.3);
    expect(engine.mode).toBe('failure'); expect(engine.glowW.failure.t).toBe(1);
  });
  it('reduced motion snaps springs, freezes orbit, and uses a single still heart', () => {
    const { engine } = make(true);
    engine.setMode('working');
    const angle = engine.orbA;
    expect(engine.update(1 / 60)).toBe(false);
    expect(engine.orbA).toBe(angle);
    engine.react('cookie'); advance(engine, .9);
    expect(engine.particleCount).toBe(2);
    expect(engine.sx.x).toBe(1);
    advance(engine, 2);
    expect(engine.particleCount).toBe(0);
    engine.react('celebrate');
    expect(engine.particleCount).toBe(0);
    engine.react('dizzy'); advance(engine, 1.21);
    expect(engine.busyWith).toBeNull();
  });
  it('uses ephemeral pointer gaze and removes every node/timer on dispose', () => {
    const { engine, root } = make();
    engine.sense(30, 22);
    expect(engine.gx.t).toBe(2.1);
    expect(engine.perk.t).toBe(1);
    engine.react('cookie'); advance(engine, 1.1);
    engine.dispose();
    expect(root.children).toHaveLength(0);
    expect(engine.timerCount).toBe(0);
    expect(engine.effectCount).toBe(0);
  });
  it('gaze never reads or writes storage, and pointer leave restores the functional pose', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('gaze must not read storage'); }), setItem: vi.fn(() => { throw new Error('gaze must not persist'); }) };
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
    try {
      const { engine } = make();
      engine.setMode('attention'); engine.sense(30, 22); engine.leave();
      expect(engine.gx.t).toBe(0); expect(engine.gy.t).toBe(1.3); expect(engine.open.t).toBe(1.12);
      expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
