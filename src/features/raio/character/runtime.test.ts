import { describe, expect, it, vi } from 'vitest';
import { CharacterLoop, bindCharacterInteraction, characterReducedMotion, initializeCharacterFrame, mountCharacter, requestCharacterReaction, setCharacterFrozenTime } from './runtime';
import type { CharacterEngine } from './engine';
import { setNativeSurfaceVisible } from '../../../shared/motion/surfaceVisibility';
const setup = () => {
  let visible = true;
  let visibility = () => {};
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const pointerStop = vi.fn(); const visibilityStop = vi.fn();
  const pointer = vi.fn(() => pointerStop);
  const loop = new CharacterLoop({
    now: () => 0, request: fn => { frames.set(++id, fn); return id; }, cancel: n => { frames.delete(n); },
    visible: () => visible, subscribeVisibility: fn => { visibility = fn; return visibilityStop; },
    subscribePointer: pointer,
  });
  const frame = (at: number) => { const item = frames.entries().next().value!; frames.delete(item[0]); item[1](at); };
  return { loop, frames, frame, pointer, pointerStop, visibilityStop, hide: () => { visible = false; visibility(); }, show: () => { visible = true; visibility(); } };
};
describe('one character loop per window', () => {
  it('shares a frame across instances, stops at rest, and removes subscriptions on last unmount', () => {
    const s = setup();
    const a = { update: vi.fn(() => false), sense: vi.fn(), leave: vi.fn(), react: vi.fn() };
    const b = { ...a, update: vi.fn(() => false) };
    const stopA = s.loop.add(a), stopB = s.loop.add(b);
    expect(s.frames.size).toBe(1);
    s.frame(16);
    expect(a.update).toHaveBeenCalledOnce(); expect(b.update).toHaveBeenCalledOnce();
    expect(s.frames.size).toBe(0);
    stopA(); stopB();
    expect(s.pointerStop).toHaveBeenCalledOnce(); expect(s.visibilityStop).toHaveBeenCalledOnce();
  });
  it('cancels frames and gaze while native-hidden; no hidden requests are queued; resumes without elapsed catch-up', () => {
    const s = setup();
    const a = { update: vi.fn((_dt: number) => true), sense: vi.fn(), leave: vi.fn(), react: vi.fn() };
    const stop = s.loop.add(a);
    s.frame(16); s.hide();
    expect(s.frames.size).toBe(0); expect(s.pointerStop).toHaveBeenCalledOnce();
    s.loop.react('round'); expect(a.react).not.toHaveBeenCalled();
    s.show(); s.frame(50_000);
    expect(a.update.mock.calls.at(-1)?.[0]).toBeLessThanOrEqual(.05);
    expect(a.react).not.toHaveBeenCalled();
    stop(); expect(s.frames.size).toBe(0);
  });
  it('does not schedule a second frame when an effect wakes during the current frame', () => {
    const s = setup();
    const stop = s.loop.add({ update: () => { s.loop.wake(); return true; }, sense: () => {}, leave: () => {}, react: () => {} });
    s.frame(16); expect(s.frames.size).toBe(1); stop();
  });
  it('supports deterministic manual stepping without any automatic frames', () => {
    const s = setup(); s.loop.setManual(true);
    const update = vi.fn((_dt: number) => true);
    const stop = s.loop.add({ update, sense: () => {}, leave: () => {}, react: () => {} });
    s.loop.advance(1);
    expect(s.frames.size).toBe(0);
    expect(update).toHaveBeenCalledTimes(60);
    expect(update.mock.calls.every(([dt]) => dt <= 1 / 60)).toBe(true);
    stop();
  });
  it('lets the harness initialize a frozen pose with deterministic frame steps', () => {
    const update = vi.fn((_dt: number) => true);
    setCharacterFrozenTime(2.5);
    initializeCharacterFrame({ update });
    expect(update).toHaveBeenCalledTimes(150);
    expect(update.mock.calls.reduce((total, [dt]) => total + dt, 0)).toBeCloseTo(2.5);
    setCharacterFrozenTime(null); update.mockClear(); initializeCharacterFrame({ update });
    expect(update).not.toHaveBeenCalled();
  });
});
it('body interactions only react, swallow clicks/double clicks, never focus or switch a surface, and remove listeners', () => {
  const hit = Object.assign(new EventTarget(), { setAttribute: vi.fn() });
  const react = vi.fn(); const showSurface = vi.fn(); const focus = vi.fn();
  let at = 0;
  const svg = { getBoundingClientRect: () => ({ left: 0, width: 44 }), focus };
  const engine = { hit, svg, react } as unknown as CharacterEngine;
  const stop = bindCharacterInteraction(engine, () => at);
  const send = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: 30 });
    hit.dispatchEvent(event);
    if (!event.cancelBubble && !event.defaultPrevented) showSurface();
    return event;
  };
  for (let i = 0; i < 4; i++) { send('pointerdown'); at += 200; }
  expect(react.mock.calls.map(([kind]) => kind)).toEqual(['click', 'click', 'click', 'dizzy']);
  expect(react.mock.calls[0]?.[1]).toBe(1);
  expect(send('dblclick').defaultPrevented).toBe(true);
  expect(send('click').defaultPrevented).toBe(true);
  expect(showSurface).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  stop(); send('pointerdown'); expect(react).toHaveBeenCalledTimes(4);
});

it('the window bus reaches every mounted character and releases DOM/media listeners and frames on unmount', () => {
  class Target extends EventTarget {
    readonly listeners = new Set<EventListenerOrEventListenerObject>();
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      if (listener) this.listeners.add(listener); super.addEventListener(type, listener, options);
    }
    override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
      if (listener) this.listeners.delete(listener); super.removeEventListener(type, listener, options);
    }
  }
  const win = new Target(), media = Object.assign(new Target(), { matches: false });
  const doc = Object.assign(new Target(), { visibilityState: 'visible', documentElement: { classList: { toggle: vi.fn() } } });
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc); vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
  const a = { update: () => false, sense: vi.fn(), leave: vi.fn(), react: vi.fn(), dispose: vi.fn(), reconcileReducedMotion: vi.fn() };
  const b = { ...a, react: vi.fn(), dispose: vi.fn() };
  let stopA: (() => void) | undefined, stopB: (() => void) | undefined;
  try {
    stopA = mountCharacter(a as unknown as CharacterEngine); stopB = mountCharacter(b as unknown as CharacterEngine);
    expect(frames.size).toBe(1); expect(media.listeners.size).toBe(1);
    requestCharacterReaction('cookie'); expect(a.react).toHaveBeenCalledWith('cookie'); expect(b.react).toHaveBeenCalledWith('cookie');
    const move = Object.assign(new Event('pointermove'), { clientX: 10, clientY: 20 }); win.dispatchEvent(move);
    expect(a.sense).toHaveBeenCalledWith(10, 20);
    setNativeSurfaceVisible(false);
    expect(frames.size).toBe(0); expect(win.listeners.size).toBe(0);
    requestCharacterReaction('round'); expect(a.react).toHaveBeenCalledTimes(1);
    setNativeSurfaceVisible(true);
    media.matches = true; media.dispatchEvent(new Event('change'));
    expect(characterReducedMotion()).toBe(true); expect(a.reconcileReducedMotion).toHaveBeenCalled();
    stopA(); stopA = undefined; stopB(); stopB = undefined;
    expect(a.dispose).toHaveBeenCalledOnce(); expect(b.dispose).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0); expect(win.listeners.size).toBe(0); expect(doc.listeners.size).toBe(0); expect(media.listeners.size).toBe(0);
  } finally { stopA?.(); stopB?.(); setNativeSurfaceVisible(true); vi.unstubAllGlobals(); }
});
