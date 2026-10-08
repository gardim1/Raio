import { expect, it, vi } from 'vitest';
import { listenIslandPointer } from './nativeBridge';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
it('registers the native listener before reading initial cursor truth and ignores malformed payloads', async () => {
  const values: boolean[] = []; const order: string[] = []; let send!: (inside: unknown) => void;
  const stop = await listenIslandPointer({
    listen: async handler => { order.push('listen'); send = handler; return () => {}; },
    read: async () => { order.push('read'); return true; },
  }, value => values.push(value));
  await Promise.resolve(); expect(order).toEqual(['listen', 'read']); expect(values).toEqual([true]);
  send('false'); send(false); expect(values).toEqual([true, false]); stop(); send(true); expect(values).toEqual([true, false]);
});
it('never overwrites a newer native boundary with a stale initial answer', async () => {
  const sample = deferred<boolean>(); const update = vi.fn(); let send!: (value: unknown) => void;
  const stop = await listenIslandPointer({ listen: async handler => { send = handler; return () => {}; }, read: () => sample.promise }, update);
  send(false); sample.resolve(true); await Promise.resolve(); expect(update.mock.calls).toEqual([[false]]); stop();
});
it('drops the initial sample when the registration was disposed while it was in flight', async () => {
  const sample = deferred<boolean>(); const update = vi.fn(); const unlisten = vi.fn();
  const stop = await listenIslandPointer({ listen: async () => unlisten, read: () => sample.promise }, update);
  stop(); sample.resolve(true); await Promise.resolve(); expect(update).not.toHaveBeenCalled(); expect(unlisten).toHaveBeenCalledOnce();
});
