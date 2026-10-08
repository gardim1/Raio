import { afterEach, expect, it, vi } from 'vitest';
import { createIslandHover, followIslandPointer } from './islandHover';

afterEach(() => vi.useRealTimers());
const fixture = () => {
  vi.useFakeTimers();
  let open = false;
  const hover = createIslandHover(value => { open = value; });
  return { hover, open: () => open };
};
it('opens from native pointer truth without DOM hover and allows a 250 ms exit grace', () => {
  const f = fixture();
  f.hover.pointer(true); expect(f.open()).toBe(true);
  f.hover.pointer(false); vi.advanceTimersByTime(249); expect(f.open()).toBe(true);
  vi.advanceTimersByTime(1); expect(f.open()).toBe(false);
});
it('an idle outside sample schedules no rendering work', () => {
  const f = fixture(); f.hover.pointer(false); expect(vi.getTimerCount()).toBe(0); expect(f.open()).toBe(false);
});
it('cancels exit on re-entry into the preview and keeps open while focus is inside', () => {
  const f = fixture(); f.hover.pointer(true); f.hover.pointer(false);
  vi.advanceTimersByTime(200); f.hover.pointer(true); vi.advanceTimersByTime(100); expect(f.open()).toBe(true);
  f.hover.focus(true); f.hover.pointer(false); vi.advanceTimersByTime(1000); expect(f.open()).toBe(true);
  f.hover.focus(false); vi.advanceTimersByTime(250); expect(f.open()).toBe(false);
});
it('Escape collapses even with pointer/focus inside, until a new entry', () => {
  const f = fixture(); f.hover.pointer(true); f.hover.focus(true); f.hover.escape();
  expect(f.open()).toBe(false); f.hover.pointer(true); expect(f.open()).toBe(false);
  f.hover.focus(false); f.hover.pointer(false); f.hover.pointer(true); expect(f.open()).toBe(true);
});
it('hide/unmount clears the grace timer and ignores later events', () => {
  const f = fixture(); f.hover.pointer(true); f.hover.pointer(false); f.hover.dispose();
  expect(vi.getTimerCount()).toBe(0); f.hover.pointer(true); f.hover.focus(true);
  vi.advanceTimersByTime(1000); expect(f.open()).toBe(false);
});
it('unsubscribes a late native listener and ignores its events after hide', async () => {
  const f = fixture(); let send!: (inside: boolean) => void; let register!: (stop: () => void) => void;
  let stops = 0;
  const stop = followIslandPointer(listener => { send = listener; return new Promise(done => { register = done; }); }, f.hover.pointer);
  stop(); register(() => { stops++; }); await Promise.resolve();
  send(true); expect(f.open()).toBe(false); expect(stops).toBe(1);
});
