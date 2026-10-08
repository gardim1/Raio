import type { CharacterMode, CharacterReaction, CharacterSize } from './types';

/** Variant A, ported from the owner's raio-companion-A.html. No variant B/demo code. */
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const eo = (x: number) => 1 - Math.pow(1 - x, 3);
const eio = (x: number) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const STAR = (s: number) => `M0,${-s} Q${.22 * s},${-.22 * s} ${s},0 Q${.22 * s},${.22 * s} 0,${s} Q${-.22 * s},${.22 * s} ${-s},0 Q${-.22 * s},${-.22 * s} 0,${-s}Z`;
const HEART = 'M0,1.6 C-2.6,-.4 -2.2,-2.6 -1.1,-2.6 C-.5,-2.6 0,-2.1 0,-1.6 C0,-2.1 .5,-2.6 1.1,-2.6 C2.2,-2.6 2.6,-.4 0,1.6Z';
export const GLOW = {
  idle: ['#ffffff', '#e6ecf7', .34], working: ['#a2c4ff', '#7fa8ff', .6],
  attention: ['#ffcf8a', '#f5b65c', .6], failure: ['#ff9a92', '#ff6f66', .5], passed: ['#b8f0cf', '#7fd8a6', .55],
} as const;
const MODES = Object.keys(GLOW) as CharacterMode[];
let uid = 0;

export class Spring {
  v = 0;
  t: number;
  constructor(public x: number, readonly k = 170, readonly c = 18) { this.t = x; }
  step(dt: number) { const a = -this.k * (this.x - this.t) - this.c * this.v; this.v += a * dt; this.x += this.v * dt; }
  get busy() { return Math.abs(this.x - this.t) > .002 || Math.abs(this.v) > .01; }
  snap() { this.x = this.t; this.v = 0; }
}
interface Effect { t: number; dur: number; fn: (k: number, t: number, dt: number) => void; done?: () => void }
interface Timer { at: number; fn: () => void }
interface Spark { g: SVGElement; x: Spring; y: Spring; s: Spring; ph: number }
export interface EngineOptions {
  readonly reduced: () => boolean;
  readonly wake: () => void;
  readonly random?: () => number;
  /** Map hosts are groups; their client bounds differ from the reference's square SVG. */
  readonly pointerGeometry?: () => { cx: number; cy: number; unit: number } | undefined;
}

export class CharacterEngine {
  readonly id = `raio-char-${uid++}`;
  mode: CharacterMode = 'idle';
  busyWith: 'dizzy' | 'cookie' | 'round' | null = null;
  tAlive = 0;
  orbA: number;
  readonly sx = new Spring(1, 520, 16); readonly sy = new Spring(1, 520, 16);
  readonly tilt = new Spring(0, 210, 14); readonly ox = new Spring(0, 200, 18); readonly oy = new Spring(0, 200, 16);
  readonly gx = new Spring(0, 260, 24); readonly gy = new Spring(0, 260, 24); readonly perk = new Spring(0, 180, 16);
  readonly open = new Spring(1, 400, 30);
  readonly ex = { normal: new Spring(1, 300, 30), happy: new Spring(0, 300, 30), closed: new Spring(0, 500, 40), dizzy: new Spring(0, 300, 30) };
  readonly glowW = Object.fromEntries(MODES.map(k => [k, new Spring(k === 'idle' ? 1 : 0, 40, 13)])) as Record<CharacterMode, Spring>;
  readonly springs = [this.sx, this.sy, this.tilt, this.ox, this.oy, this.gx, this.gy, this.perk, this.open, ...Object.values(this.ex), ...Object.values(this.glowW)];
  sparkMode: 'rest' | 'orbit' | 'dizzy' | 'wave' = 'rest';
  readonly sparks: Spark[] = [];
  readonly gGlow: SVGElement; readonly gBody: SVGElement; readonly gEyes: SVGElement; readonly gFx: SVGElement;
  readonly glows: Record<CharacterMode, SVGElement>;
  readonly eN: SVGElement; readonly eL: SVGElement; readonly eR: SVGElement;
  readonly eH: SVGElement; readonly eC: SVGElement; readonly eD: SVGElement;
  readonly cL?: SVGElement; readonly cR?: SVGElement;
  readonly hit: SVGElement;
  private effects: Effect[] = [];
  private timers: Timer[] = [];
  private nodes: SVGElement[] = [];
  private particles = new Set<SVGElement>();
  private nextBlink: number | undefined;
  private celebrating = false;
  private disposed = false;
  private cookieFinishes = new Set<() => void>();
  private clock = 0;
  private readonly random: () => number;
  constructor(readonly svg: SVGGraphicsElement, readonly size: CharacterSize, private readonly options: EngineOptions) {
    this.random = options.random ?? Math.random;
    this.orbA = this.random() * 6;
    const defs = this.E('defs', {}, svg);
    const gradient = (id: string, attrs: Record<string, string>, stops: readonly Record<string, string | number>[]) => {
      const g = this.E('radialGradient', { id, ...attrs }, defs);
      stops.forEach(stop => this.E('stop', stop, g));
    };
    gradient(`${this.id}b`, { cx: '40%', cy: '35%', r: '70%' }, [{ offset: 0, 'stop-color': '#fff' }, { offset: .5, 'stop-color': '#dbe9ff' }, { offset: 1, 'stop-color': '#86aefc' }]);
    MODES.forEach(k => { const [c1, c2] = GLOW[k]; gradient(`${this.id}g${k}`, {}, [{ offset: 0, 'stop-color': c1, 'stop-opacity': .6 }, { offset: .4, 'stop-color': c2, 'stop-opacity': .16 }, { offset: 1, 'stop-color': c2, 'stop-opacity': 0 }]); });
    gradient(`${this.id}sp`, {}, [{ offset: 0, 'stop-color': '#fff', 'stop-opacity': .55 }, { offset: 1, 'stop-color': '#cfe0ff', 'stop-opacity': 0 }]);
    this.gGlow = this.E('g', {}, svg);
    this.glows = Object.fromEntries(MODES.map(k => [k, this.E('circle', { r: 26, fill: `url(#${this.id}g${k})`, opacity: 0 }, this.gGlow)])) as Record<CharacterMode, SVGElement>;
    this.gBody = this.E('g', { class: 'raio-char__body' }, svg);
    this.E('circle', { r: 11, fill: `url(#${this.id}b)` }, this.gBody);
    this.E('ellipse', { cx: -3.6, cy: -5, rx: 3.2, ry: 1.8, fill: '#fff', opacity: .75 }, this.gBody);
    this.gEyes = this.E('g', {}, this.gBody);
    this.eN = this.E('g', {}, this.gEyes);
    const ink = '#1b2544', x = 3.7, y = .6, w = 1.6;
    this.eL = this.E('ellipse', { cx: -x, cy: y, rx: 1.5, ry: 2.7, fill: ink }, this.eN);
    this.eR = this.E('ellipse', { cx: x, cy: y, rx: 1.5, ry: 2.7, fill: ink }, this.eN);
    if (size === 'big') {
      this.cL = this.E('circle', { cx: -x + .5, cy: y - 1.1, r: .5, fill: '#fff' }, this.eN);
      this.cR = this.E('circle', { cx: x + .5, cy: y - 1.1, r: .5, fill: '#fff' }, this.eN);
    }
    const line = (d: string) => ({ d, fill: 'none', stroke: ink, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    this.eH = this.E('path', line(`M${-x-w},${y+.9} Q${-x},${y-1.9} ${-x+w},${y+.9} M${x-w},${y+.9} Q${x},${y-1.9} ${x+w},${y+.9}`), this.gEyes);
    this.eC = this.E('path', line(`M${-x-w},${y-.9} L${-x+w*.7},${y} L${-x-w},${y+.9} M${x+w},${y-.9} L${x-w*.7},${y} L${x+w},${y+.9}`), this.gEyes);
    this.eD = this.E('path', line(`M${-x-w},${y} q${w*.5},-1.3 ${w},0 t${w},0 M${x-w},${y+.4} q${w*.5},-1.3 ${w},0 t${w},0`), this.gEyes);
    const gSparks = this.E('g', {}, svg);
    for (let i = 0; i < 3; i++) {
      const g = this.E('g', {}, gSparks);
      this.E('circle', { r: 4.6, fill: `url(#${this.id}sp)` }, g);
      this.E('path', { d: STAR(2.4), fill: '#fff' }, g);
      const sp = { g, x: new Spring(0, 120, 13), y: new Spring(0, 120, 13), s: new Spring(0, 160, 16), ph: i * 2.094 };
      this.sparks.push(sp); this.springs.push(sp.x, sp.y, sp.s);
    }
    this.gFx = this.E('g', {}, svg);
    this.hit = this.E('circle', { r: 15, fill: 'transparent' }, svg);
    this.updateSparkTargets(0, true); this.draw();
  }
  private E(tag: string, attrs: Record<string, string | number>, parent: SVGElement): SVGElement {
    const el = this.svg.ownerDocument.createElementNS(NS, tag) as SVGElement;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    parent.appendChild(el);
    if (parent === this.svg) this.nodes.push(el);
    return el;
  }
  private particle(tag: string, attrs: Record<string, string | number>) {
    const el = this.E(tag, attrs, this.gFx); this.particles.add(el); return el;
  }
  private removeParticle(el: SVGElement) { el.remove(); this.particles.delete(el); }
  private later(seconds: number, fn: () => void) { this.timers.push({ at: this.clock + seconds, fn }); this.options.wake(); }
  private fx(dur: number, fn: Effect['fn'], done?: () => void) { this.effects.push({ t: 0, dur, fn, ...(done ? { done } : {}) }); this.options.wake(); }
  private setExpr(name: keyof CharacterEngine['ex']) { for (const k of Object.keys(this.ex) as (keyof CharacterEngine['ex'])[]) this.ex[k].t = k === name ? 1 : 0; }
  private recover(owner: 'dizzy' | 'cookie' | 'round') {
    // A newer dizzy reaction can interrupt an existing cookie/round in the reference.
    if (this.busyWith !== owner) return;
    this.busyWith = null; this.setExpr('normal'); this.oy.t = 0; this.sx.t = 1;
    this.sy.t = this.mode === 'failure' ? .97 : 1;
    this.gy.t = this.mode === 'attention' || this.mode === 'failure' ? 1.3 : 0;
    this.open.t = this.mode === 'attention' ? 1.12 : 1;
    this.sparkMode = this.mode === 'working' ? 'orbit' : 'rest';
  }
  get effectCount() { return this.effects.length; }
  get timerCount() { return this.timers.length; }
  get particleCount() { return this.particles.size; }
  setMode(mode: CharacterMode) {
    this.mode = mode;
    MODES.forEach(k => { this.glowW[k].t = k === mode ? 1 : 0; });
    this.sparkMode = mode === 'working' ? 'orbit' : 'rest';
    this.open.t = mode === 'attention' ? 1.12 : 1;
    this.gy.t = mode === 'attention' || mode === 'failure' ? 1.3 : 0; this.gx.t = 0;
    this.perk.t = mode === 'failure' ? -1 : 0; this.sy.t = mode === 'failure' ? .97 : 1;
    this.options.wake();
  }
  private updateSparkTargets(dt: number, init = false) {
    const t = this.tAlive, m = this.sparkMode;
    if (m === 'orbit' && !this.options.reduced()) this.orbA += dt * 1.25;
    this.sparks.forEach((sp, i) => {
      let x = 0, y = 0, s = 0;
      if (m === 'orbit') { const a = this.orbA + i * 2.094; x = Math.cos(a) * 17; y = Math.sin(a) * 17 * .48; s = 1; }
      else if (m === 'dizzy') { const a = t * [3.3, 4.4, 2.7][i]! + sp.ph; x = Math.cos(a) * (10 + i * 1.6); y = -16.5 + Math.sin(a) * 3.6 + Math.sin(t * 9 + i) * .6; s = .85; }
      else if (m === 'wave') { const a = -Math.PI / 2 + Math.sin(t * 7) * .5 + i * .35 - .35; x = Math.cos(a) * 17; y = Math.sin(a) * 17; s = .9; }
      sp.x.t = x; sp.y.t = y; sp.s.t = s;
      if (init) { sp.x.snap(); sp.y.snap(); sp.s.snap(); }
    });
  }
  react(kind: CharacterReaction, side = 0) {
    if (this.disposed) return;
    const R = this.options.reduced();
    if (kind === 'click') {
      if (this.busyWith === 'dizzy') return;
      this.setExpr('closed');
      this.later(R ? .18 : .14, () => { if (this.busyWith !== 'dizzy' && this.busyWith !== 'cookie') this.setExpr(this.ex.happy.t ? 'happy' : 'normal'); });
      if (R) return;
      this.sx.x = 1.12; this.sy.x = .85; this.tilt.v += side * 90; this.oy.v += 26;
      this.sparks.forEach((sp, i) => { if (this.sparkMode === 'rest') { sp.s.x = .9; const a = -Math.PI / 2 + (i - 1) * .6; sp.x.x = Math.cos(a) * 15; sp.y.x = Math.sin(a) * 15; } });
      this.options.wake();
    }
    if (kind === 'dizzy') {
      if (this.busyWith === 'dizzy') return;
      this.busyWith = 'dizzy'; const prev = this.sparkMode; this.setExpr('dizzy');
      if (!R) { this.sx.x = 1.18; this.sy.x = .8; this.sparkMode = 'dizzy'; this.sparks.forEach(sp => { sp.x.v += (this.random() - .5) * 300; sp.y.v -= 150 + this.random() * 120; }); }
      this.fx(R ? 1.2 : 2.35, (_k, t) => {
        if (R) return;
        if (t < 1.55) this.tilt.t = Math.sin(t * 7.5) * 9 * (1 - t / 1.7);
        else if (t < 1.6) { this.sparkMode = prev === 'orbit' ? 'orbit' : 'rest'; this.tilt.t = 0; }
        if (t > 1.6 && t < 1.62) this.flash();
        if (t > 1.85 && t < 2.25) this.tilt.t = Math.sin((t - 1.85) / .4 * Math.PI * 2) * 7;
        else if (t >= 2.25) this.tilt.t = 0;
        if (t > 1.95) this.setExpr('normal');
      }, () => { this.recover('dizzy'); this.tilt.t = 0; });
    }
    if (kind === 'cookie') {
      this.startCookie(false);
    }
    if (kind === 'round') {
      if (this.busyWith) return;
      this.busyWith = 'round'; if (!R) this.sparkMode = 'wave';
      this.fx(R ? 1 : 1.9, (_k, t) => {
        if (R) { if (t < .9) this.setExpr('happy'); return; }
        this.tilt.t = t < .9 ? Math.sin(t / .9 * Math.PI * 2) * 8 * (1 - t / 1.1) : 0;
        if (t > .9 && t < .95) { this.sparkMode = 'rest'; this.setExpr('happy'); this.oy.t = 1.6; this.sx.t = 1.03; this.sy.t = .97; }
        if (t > 1.55) { this.setExpr('normal'); this.oy.t = 0; this.sx.t = 1; this.sy.t = 1; }
      }, () => { this.recover('round'); });
    }
    if (kind === 'celebrate') {
      // The demo permits overlapping bursts; bound repeated manual requests to one burst.
      if (this.celebrating) return;
      this.celebrating = true; this.setExpr('happy');
      if (!R) { this.oy.v -= 95; this.sx.x = .9; this.sy.x = 1.12; this.confetti(); }
      this.fx(1.4, () => {}, () => { this.celebrating = false; this.setExpr('normal'); });
    }
  }
  /** External flight replaces only the prototype's first .5 s; REDUCED is unchanged. */
  cookieArrived(onFinished?: () => void): boolean { return this.startCookie(true, onFinished); }
  private startCookie(arrived: boolean, onFinished?: () => void): boolean {
    if (this.disposed || this.busyWith) return false;
    const R = this.options.reduced(), offset = arrived && !R ? .5 : 0;
    this.busyWith = 'cookie';
    const finish = () => { if (this.cookieFinishes.delete(finish)) onFinished?.(); };
    this.cookieFinishes.add(finish);
    const ck = this.particle('g', { class: 'raio-char__cookie', opacity: offset ? 1 : 0, ...(offset ? { transform: 'translate(0 4.5) scale(1)' } : {}) });
    this.E('circle', { r: 5, fill: '#d9a066' }, ck); this.E('circle', { r: 5, fill: 'none', stroke: '#b9824c', 'stroke-width': .6 }, ck);
    [[-1.8, -1.2], [1.6, -.6], [-.2, 1.8], [1.9, 2]].forEach(([x, y]) => this.E('circle', { cx: x!, cy: y!, r: .75, fill: '#5e3b22' }, ck));
    const bite = this.E('circle', { cx: 4.6, cy: -2.6, r: 0, fill: '#1d2028' }, ck);
    let c1 = false, c2 = false, h = false;
    this.open.t = 1.25; this.gy.t = offset ? 1.2 : -1.6;
    this.fx(R ? 1.6 : 2.3 - offset, (_k, elapsed) => {
      const t = elapsed + offset;
      if (R) { ck.setAttribute('opacity', String(t < .6 ? eo(t / .3) : Math.max(0, 1 - (t - .6) / .2))); ck.setAttribute('transform', 'translate(0 -19)'); if (t > .8 && !h) { h = true; this.setExpr('happy'); this.heart(0, 0, true); } return; }
      const fall = eio(clamp(t / .5)); ck.setAttribute('opacity', String(Math.min(1, t / .12)));
      const cy = lerp(-34, 4.5, fall), sc = t < .62 ? 1 : t < .86 ? .62 : 0;
      ck.setAttribute('transform', `translate(0 ${cy}) scale(${sc})`);
      if (t > .5) this.gy.t = 1.2;
      if (t > .55 && !c1) { c1 = true; this.chomp(); bite.setAttribute('r', '2.4'); }
      if (t > .8 && !c2) { c2 = true; this.chomp(); }
      if (t > 1 && !h) { h = true; this.setExpr('happy'); this.open.t = 1; this.gy.t = 0; [0, .22, .44].forEach((d, i) => this.later(d, () => this.heart((i - 1) * 6, -4))); }
    }, () => { this.removeParticle(ck); this.recover('cookie'); finish(); });
    return true;
  }
  private chomp() {
    this.sx.x = 1.1; this.sy.x = .88;
    for (let i = 0; i < 3; i++) {
      const c = this.particle('circle', { class: 'raio-char__crumb', r: .7, fill: '#c9945e', cx: 0, cy: 7, opacity: 0 });
      const vx = (this.random() - .5) * 16, vy = -6 - this.random() * 6; let x = (this.random() - .5) * 4, y = 7;
      this.fx(.7, k => { x += vx * .016; y += (vy + 60 * k) * .016; c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); c.setAttribute('opacity', String(1 - k)); }, () => this.removeParticle(c));
    }
  }
  private heart(x0: number, y0: number, still = false) {
    const g = this.particle('g', { class: 'raio-char__heart', opacity: 0 }); this.E('path', { d: HEART, fill: '#ff9fb8' }, g);
    const drift = (this.random() - .5) * 4;
    this.fx(1.3, k => { const y = still ? y0 - 16 : lerp(y0 - 12, y0 - 30, eo(k)); g.setAttribute('transform', `translate(${x0 + drift * k} ${y}) scale(${still ? 1.4 : lerp(.9, 1.5, eo(k))})`); g.setAttribute('opacity', String(k < .2 ? k / .2 : 1 - (k - .2) / .8)); }, () => this.removeParticle(g));
  }
  private confetti() {
    const cols = ['#a9c8ff', '#7fd8a6', '#ffffff', '#ffd28f'];
    for (let i = 0; i < 7; i++) {
      const r = this.particle('rect', { x: -.7, y: -1.2, width: 1.4, height: 2.4, rx: .4, fill: cols[i % 4]! });
      const a = -Math.PI / 2 + (i - 3) * .32 + (this.random() - .5) * .2, sp = 34 + this.random() * 12;
      let vx = Math.cos(a) * sp, vy = Math.sin(a) * sp, x = 0, y = -8, rot = this.random() * 180;
      this.fx(1.1, (k, _t, dt) => { vy += 55 * dt; x += vx * dt; y += vy * dt; vx *= .985; rot += dt * 400; r.setAttribute('transform', `translate(${x} ${y}) rotate(${rot})`); r.setAttribute('opacity', String(k < .7 ? 1 : 1 - (k - .7) / .3)); }, () => this.removeParticle(r));
    }
  }
  private flash() { this.sparks.forEach(sp => { sp.s.x = 1.5; }); }
  sense(px: number, py: number) {
    if (this.busyWith === 'dizzy') return;
    const r = this.svg.getBoundingClientRect();
    const geo = this.options.pointerGeometry?.() ?? (r.width ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, unit: r.width / (this.size === 'big' ? 80 : 44) } : undefined);
    if (!geo) return;
    const dx = px - geo.cx, dy = py - geo.cy, d = Math.hypot(dx, dy), body = 11 * geo.unit;
    if (!body) return;
    const aware = clamp(1 - (d - body) / (body * 6)), nx = d ? dx / d : 0, ny = d ? dy / d : 0;
    const baseGy = this.mode === 'attention' || this.mode === 'failure' ? 1.3 : 0;
    this.gx.t = nx * 2.1 * aware; this.gy.t = lerp(baseGy, ny * 1.6, aware);
    if (!this.options.reduced()) { this.tilt.t = this.effects.length ? this.tilt.t : nx * 6 * aware; this.perk.t = this.mode === 'failure' ? -1 : aware; }
    if (this.options.reduced()) { this.gx.snap(); this.gy.snap(); }
    this.options.wake();
  }
  leave() { this.gx.t = 0; this.gy.t = this.mode === 'attention' || this.mode === 'failure' ? 1.3 : 0; this.tilt.t = 0; this.perk.t = this.mode === 'failure' ? -1 : 0; this.options.wake(); }
  reconcileReducedMotion() { this.springs.forEach(s => s.snap()); this.updateSparkTargets(0, true); this.draw(); }
  update(dt: number): boolean {
    if (this.disposed) return false;
    this.clock += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) { const tm = this.timers[i]!; if (this.clock >= tm.at) { this.timers.splice(i, 1); tm.fn(); } }
    this.tAlive += dt;
    const cur = this.effects; this.effects = [];
    const keep = cur.filter(e => { e.t += dt; const k = clamp(e.t / e.dur); e.fn(k, e.t, dt); if (k >= 1) { e.done?.(); return false; } return true; }); this.effects = keep.concat(this.effects);
    this.updateSparkTargets(dt);
    const reduced = this.options.reduced();
    if (this.mode === 'working' && !reduced && !this.busyWith) { this.nextBlink = (this.nextBlink ?? 2.5) - dt; if (this.nextBlink <= 1e-9) { this.open.x = .1; this.open.v = 0; this.nextBlink = 3 + this.random() * 2.5; } }
    for (const s of this.springs) reduced ? s.snap() : s.step(Math.min(dt, 1 / 30));
    this.draw();
    return this.timers.length > 0 || this.effects.length > 0 || (this.mode === 'working' && !reduced) || this.springs.some(s => s.busy);
  }
  private draw() {
    MODES.forEach(k => this.glows[k].setAttribute('opacity', (this.glowW[k].x * GLOW[k][2] * 1.6).toFixed(3)));
    const sc = 1 + .035 * Math.max(0, this.perk.x);
    this.gBody.setAttribute('transform', `translate(${this.ox.x.toFixed(2)} ${(this.oy.x - .6 * this.perk.x).toFixed(2)}) rotate(${this.tilt.x.toFixed(2)}) translate(0 6) scale(${(this.sx.x * sc).toFixed(4)} ${(this.sy.x * sc).toFixed(4)}) translate(0 -6)`);
    this.gGlow.setAttribute('transform', `translate(${this.ox.x.toFixed(2)} ${this.oy.x.toFixed(2)})`);
    this.gEyes.setAttribute('transform', `translate(${this.gx.x.toFixed(2)} ${this.gy.x.toFixed(2)})`);
    const ry = 2.7 * clamp(this.open.x, .08, 1.4); this.eL.setAttribute('ry', ry.toFixed(3)); this.eR.setAttribute('ry', ry.toFixed(3));
    const ex = this.ex, tot = Math.max(.001, ex.normal.x + ex.happy.x + ex.closed.x + ex.dizzy.x);
    this.eN.setAttribute('opacity', clamp(ex.normal.x / tot).toFixed(3)); this.eH.setAttribute('opacity', clamp(ex.happy.x / tot).toFixed(3)); this.eC.setAttribute('opacity', clamp(ex.closed.x / tot).toFixed(3)); this.eD.setAttribute('opacity', clamp(ex.dizzy.x / tot).toFixed(3));
    if (this.cL && this.cR) { const o = clamp(ex.normal.x / tot) * (this.open.x > .5 ? 1 : 0); this.cL.setAttribute('opacity', String(o)); this.cR.setAttribute('opacity', String(o)); }
    this.sparks.forEach(sp => { const s = Math.max(0, sp.s.x); sp.g.setAttribute('transform', `translate(${(sp.x.x + this.ox.x).toFixed(2)} ${(sp.y.x + this.oy.x).toFixed(2)}) scale(${s.toFixed(3)})`); sp.g.setAttribute('opacity', s > .02 ? '1' : '0'); });
  }
  dispose() { this.disposed = true; this.effects = []; this.timers = []; this.particles.clear(); this.nodes.forEach(n => n.remove()); this.nodes = []; this.cookieFinishes.forEach(finish => finish()); }
}
