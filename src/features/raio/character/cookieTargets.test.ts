import { describe, expect, it } from 'vitest';
import { CharacterEngine } from './engine';
import { findCookieTarget, registerCookieTarget } from './cookieTargets';

// Minimal geometry-bearing SVG tree; runs the real engine and target registry without a browser.
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
class ElementNode {
  readonly attrs: Record<string, string> = {};
  readonly children: ElementNode[] = [];
  readonly style: Record<string, string> = {};
  parentElement: ElementNode | null = null;
  isConnected = true;
  bounds = rect(0, 0, 800, 600);
  matrix = { a: 1, b: 0, c: 0, d: 1, e: 200, f: 200 };
  readonly ownerDocument: {
    createElementNS(ns: string, tag: string): ElementNode;
    defaultView: { innerWidth: number; innerHeight: number; getComputedStyle(el: ElementNode): Record<string, string> };
  };
  constructor(document?: ElementNode['ownerDocument']) {
    this.ownerDocument = document ?? {
      createElementNS: () => new ElementNode(this.ownerDocument),
      defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: el => ({ display: 'block', visibility: 'visible', opacity: el.attrs.opacity ?? '1', overflowX: 'visible', overflowY: 'visible', ...el.style }) },
    };
  }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
  appendChild(el: ElementNode) { el.parentElement = this; this.children.push(el); return el; }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); }
  contains(el: ElementNode): boolean { return el === this || this.children.some(child => child.contains(el)); }
  closest(selector: string): ElementNode | null { return this.attrs.class?.split(' ').includes(selector.slice(1)) ? this : this.parentElement?.closest(selector) ?? null; }
  getBoundingClientRect() { return this.bounds; }
  getScreenCTM() { return this.matrix; }
}
const setup = () => {
  const scope = new ElementNode();
  const create = (size: 'map' | 'island', className: string, x: number, y: number) => {
    const clip = scope.appendChild(new ElementNode(scope.ownerDocument)); clip.attrs.class = className;
    clip.style.overflowX = 'hidden'; clip.style.overflowY = 'hidden';
    const root = clip.appendChild(new ElementNode(scope.ownerDocument)); root.matrix = { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
    const engine = new CharacterEngine(root as unknown as SVGGraphicsElement, size, { reduced: () => false, wake() {}, random: () => .5 });
    (engine.gBody as unknown as ElementNode).bounds = rect(x - 11, y - 11, 22, 22);
    return { clip, root, engine, stop: registerCookieTarget(engine) };
  };
  const map = create('map', 'expanded__map', 200, 200), title = create('island', 'titlebar__brand', 30, 30);
  return { scope: scope as unknown as Element, map, title, stop: () => { map.stop(); title.stop(); map.engine.dispose(); title.engine.dispose(); } };
};
describe('visible cookie target in the current Expanded window', () => {
  it('prefers the visible map and starts only its engine, preserving both functional moods', () => {
    const f = setup();
    try {
      f.map.engine.setMode('attention');
      const target = findCookieTarget(f.scope)!;
      expect(target.measure()).toEqual({ x: 200, y: 204.5, diameter: 10 });
      expect(target.arrive(() => {})).toBe(true);
      expect(f.map.engine.busyWith).toBe('cookie');
      expect(f.title.engine.busyWith).toBeNull();
      expect([f.map.engine.mode, f.title.engine.mode]).toEqual(['attention', 'idle']);
    } finally { f.stop(); }
  });
  it.each(['clipped', 'transparent', 'hidden'] as const)('falls back to title bar for a %s map', kind => {
    const f = setup();
    try {
      if (kind === 'clipped') f.map.clip.bounds = rect(0, 0, 100, 100);
      if (kind === 'transparent') f.map.clip.attrs.opacity = '0';
      if (kind === 'hidden') f.map.clip.style.visibility = 'hidden';
      const target = findCookieTarget(f.scope)!;
      expect(target.measure()).toEqual({ x: 30, y: 34.5, diameter: 10 });
      expect(target.arrive(() => {})).toBe(true);
      expect(f.title.engine.busyWith).toBe('cookie');
      expect(f.map.engine.busyWith).toBeNull();
    } finally { f.stop(); }
  });
  it('re-measures transformed geometry and invalidates a removed engine rather than feeding its replacement', () => {
    const f = setup();
    try {
      const target = findCookieTarget(f.scope)!;
      f.map.root.matrix = { a: 2, b: 0, c: 0, d: 2, e: 300, f: 250 };
      expect(target.measure()).toEqual({ x: 300, y: 259, diameter: 20 });
      f.map.stop();
      expect(target.measure()).toBeNull();
      expect(findCookieTarget(f.scope)?.measure()).toEqual({ x: 30, y: 34.5, diameter: 10 });
    } finally { f.stop(); }
  });
});
