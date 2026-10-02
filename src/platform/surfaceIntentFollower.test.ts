import { describe, expect, it, vi } from 'vitest';
import { followSurfaceIntent, type SurfaceIntentAdapter } from './surfaceIntentFollower';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** In-memory stand-in for the window's event channel and the core's pending intent; no Tauri. */
const createFake = (pending: string | null = null) => {
  const log: string[] = [];
  let handler: ((intent: string) => void) | null = null;
  let releaseListen: () => void = () => {};
  let releaseTake: () => void = () => {};
  let holdListen = false;
  let holdTake = false;
  let pulledValue = pending;
  const stopListening = vi.fn(() => void (handler = null));
  const adapter: SurfaceIntentAdapter = {
    listen: (h) => {
      log.push('listen:start');
      handler = h;
      const resolved = () => {
        log.push('listen:resolved');
        return stopListening;
      };
      return holdListen ? new Promise((r) => (releaseListen = () => r(resolved()))) : Promise.resolve(resolved());
    },
    take: () => {
      log.push('take');
      const value = pulledValue;
      pulledValue = null;
      return holdTake ? new Promise((r) => (releaseTake = () => r(value))) : Promise.resolve(value);
    },
  };
  return {
    adapter,
    log,
    stopListening,
    emit: (intent: string) => handler?.(intent),
    holdListen: () => (holdListen = true),
    holdTake: () => (holdTake = true),
    releaseListen: () => releaseListen(),
    releaseTake: () => releaseTake(),
  };
};

describe('following a surface intent', () => {
  it('applies the intent that was pending before the window loaded', async () => {
    const fake = createFake('replay');
    const apply = vi.fn();
    followSurfaceIntent(fake.adapter, apply);
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('replay');
  });

  it('pulls only after the listener is registered, so nothing falls between the two', async () => {
    const fake = createFake('replay');
    fake.holdListen();
    followSurfaceIntent(fake.adapter, vi.fn());
    await settle();
    expect(fake.log).toEqual(['listen:start']);
    fake.releaseListen();
    await settle();
    expect(fake.log).toEqual(['listen:start', 'listen:resolved', 'take']);
  });

  it('applies nothing when no intent is pending', async () => {
    const apply = vi.fn();
    followSurfaceIntent(createFake(null).adapter, apply);
    await settle();
    expect(apply).not.toHaveBeenCalled();
  });

  it('pulls once, and applies later events as they arrive, including repeats', async () => {
    const fake = createFake(null);
    const apply = vi.fn();
    followSurfaceIntent(fake.adapter, apply);
    await settle();
    fake.emit('replay');
    fake.emit('replay');
    expect(fake.log.filter((l) => l === 'take')).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('does not apply the same intent twice when the event and the pull both carry it', async () => {
    const fake = createFake('replay');
    fake.holdTake();
    const apply = vi.fn();
    followSurfaceIntent(fake.adapter, apply);
    await settle();
    fake.emit('replay'); // arrives while the pull is still in flight
    fake.releaseTake();
    await settle();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('replay');
  });

  it('still applies a pulled intent that differs from the one an event delivered meanwhile', async () => {
    const fake = createFake('other');
    fake.holdTake();
    const apply = vi.fn();
    followSurfaceIntent(fake.adapter, apply);
    await settle();
    fake.emit('replay');
    fake.releaseTake();
    await settle();
    expect(apply.mock.calls.map((c) => c[0])).toEqual(['replay', 'other']);
  });

  it('does not pull, apply or keep listening once disposed before the listener resolved', async () => {
    const fake = createFake('replay');
    fake.holdListen();
    const apply = vi.fn();
    const dispose = followSurfaceIntent(fake.adapter, apply);
    dispose();
    fake.releaseListen();
    await settle();
    expect(fake.log).not.toContain('take');
    expect(apply).not.toHaveBeenCalled();
    expect(fake.stopListening).toHaveBeenCalledTimes(1);
  });

  it('does not apply a pull that resolves after disposal', async () => {
    const fake = createFake('replay');
    fake.holdTake();
    const apply = vi.fn();
    const dispose = followSurfaceIntent(fake.adapter, apply);
    await settle();
    dispose();
    fake.releaseTake();
    await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(fake.stopListening).toHaveBeenCalledTimes(1);
  });

  it('stops listening on dispose', async () => {
    const fake = createFake(null);
    const dispose = followSurfaceIntent(fake.adapter, vi.fn());
    await settle();
    dispose();
    expect(fake.stopListening).toHaveBeenCalledTimes(1);
  });

  it('reports a failed pull instead of throwing, and keeps following events', async () => {
    const fake = createFake(null);
    const failure = new Error('no such command');
    const report = vi.fn();
    const apply = vi.fn();
    followSurfaceIntent({ ...fake.adapter, take: () => Promise.reject(failure) }, apply, report);
    await settle();
    expect(report).toHaveBeenCalledWith('take_surface_intent', failure);
    fake.emit('replay');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('replay');
  });

  it('still pulls the pending intent when registering the listener fails', async () => {
    const fake = createFake('replay');
    const failure = new Error('listen refused');
    const report = vi.fn();
    const apply = vi.fn();
    followSurfaceIntent({ ...fake.adapter, listen: () => Promise.reject(failure) }, apply, report);
    await settle();
    expect(report).toHaveBeenCalledWith('surface-intent listen', failure);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('replay');
  });
});
