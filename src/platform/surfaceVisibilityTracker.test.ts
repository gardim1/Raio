import { afterEach, describe, expect, it } from 'vitest';
import { trackSurfaceVisibility, type SurfaceWindowAdapter } from './surfaceVisibilityTracker';

import { isSurfaceVisible, setNativeSurfaceVisible } from '../shared/motion/surfaceVisibility';
afterEach(() => setNativeSurfaceVisible(true));

type Handler<T> = (payload: T) => void;

/** In-memory stand-in for the native window and the document; no Tauri, no DOM. */
const createFake = (initial: { shown?: boolean; minimized?: boolean; pageHidden?: boolean } = {}) => {
  const state = { shown: true, minimized: false, pageHidden: false, ...initial };
  const handlers = { shownEvent: new Set<Handler<boolean>>(), windowChange: new Set<Handler<void>>(), page: new Set<Handler<void>>() };
  const pending: Array<() => void> = [];
  let holdQueries = false;
  const query = <T,>(read: () => T): Promise<T> => {
    if (!holdQueries) return Promise.resolve(read());
    const value = read();
    return new Promise((resolve) => pending.push(() => resolve(value)));
  };
  const listen = <T,>(set: Set<Handler<T>>) => (handler: Handler<T>) => {
    set.add(handler);
    return Promise.resolve(() => void set.delete(handler));
  };
  const adapter: SurfaceWindowAdapter = {
    isShown: () => query(() => state.shown),
    isMinimized: () => query(() => state.minimized),
    onShownChanged: listen(handlers.shownEvent),
    onWindowChanged: listen(handlers.windowChange),
    isPageHidden: () => state.pageHidden,
    onPageVisibilityChanged: (handler) => {
      handlers.page.add(handler);
      return () => void handlers.page.delete(handler);
    },
  };
  return {
    adapter,
    handlers,
    minimize: () => {
      state.minimized = true;
      handlers.windowChange.forEach((h) => h());
    },
    restore: () => {
      state.minimized = false;
      handlers.windowChange.forEach((h) => h());
    },
    emitShown: (shown: boolean) => {
      state.shown = shown;
      handlers.shownEvent.forEach((h) => h(shown));
    },
    setPageHidden: (hidden: boolean) => {
      state.pageHidden = hidden;
      handlers.page.forEach((h) => h());
    },
    hold: () => {
      holdQueries = true;
    },
    release: () => {
      holdQueries = false;
      pending.splice(0).forEach((resolve) => resolve());
    },
  };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const start = async (fake: ReturnType<typeof createFake>) => {
  const seen: boolean[] = [];
  const stop = trackSurfaceVisibility(fake.adapter, (visible) => seen.push(visible));
  await flush();
  return { seen, stop };
};

describe('trackSurfaceVisibility', () => {
  it('publishes the first resolved state for a shown, restored, visible surface', async () => {
    const { seen } = await start(createFake());
    expect(seen).toEqual([true]);
  });

  it('reports hidden when the window starts minimized', async () => {
    const { seen } = await start(createFake({ minimized: true }));
    expect(seen).toEqual([false]);
  });

  it('reports hidden when the page starts hidden', async () => {
    const { seen } = await start(createFake({ pageHidden: true }));
    expect(seen).toEqual([false]);
  });

  it('hides on minimize and shows again on restore', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.minimize();
    await flush();
    fake.restore();
    await flush();
    expect(seen).toEqual([true, false, true]);
  });

  it('hides when the document becomes hidden and shows when it is visible again', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.setPageHidden(true);
    fake.setPageHidden(false);
    expect(seen).toEqual([true, false, true]);
  });

  it('keeps following the app surface-visible event', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.emitShown(false);
    fake.emitShown(true);
    expect(seen).toEqual([true, false, true]);
  });

  it('stays hidden until every reason to hide is gone', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.minimize();
    await flush();
    fake.setPageHidden(true);
    fake.restore();
    await flush();
    expect(seen).toEqual([true, false]);
    fake.setPageHidden(false);
    expect(seen).toEqual([true, false, true]);
  });

  it('does not repeat a value that did not change', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.minimize();
    await flush();
    fake.minimize();
    await flush();
    expect(seen).toEqual([true, false]);
  });

  it('lets a later surface-visible event win over the slower initial query', async () => {
    const fake = createFake({ shown: false });
    fake.hold();
    const seen: boolean[] = [];
    trackSurfaceVisibility(fake.adapter, (visible) => seen.push(visible));
    fake.emitShown(true);
    fake.release();
    await flush();
    expect(seen).toEqual([true]);
  });

  it('lets the latest minimized query win when answers arrive late', async () => {
    const fake = createFake();
    const { seen } = await start(fake);
    fake.hold();
    fake.minimize();
    fake.restore();
    fake.release();
    await flush();
    expect(seen).toEqual([true]);
  });

  it('removes every listener when stopped', async () => {
    const fake = createFake();
    const { seen, stop } = await start(fake);
    stop();
    await flush();
    expect(fake.handlers.shownEvent.size + fake.handlers.windowChange.size + fake.handlers.page.size).toBe(0);
    fake.setPageHidden(true);
    expect(seen).toEqual([true]);
  });

  it('removes listeners that finish registering after it was stopped', async () => {
    const fake = createFake();
    const stop = trackSurfaceVisibility(fake.adapter, () => {});
    stop();
    await flush();
    expect(fake.handlers.shownEvent.size + fake.handlers.windowChange.size).toBe(0);
  });

  it('fails visible when the initial native queries fail', async () => {
    const fake = createFake();
    const failing: SurfaceWindowAdapter = {
      ...fake.adapter,
      isShown: () => Promise.reject(new Error('no window')),
      isMinimized: () => Promise.reject(new Error('no window')),
    };
    const seen: boolean[] = [];
    trackSurfaceVisibility(failing, (visible) => seen.push(visible));
    await flush();
    expect(seen).toEqual([true]);
  });
});

it('publishes a resolved visible startup into an initially suspended renderer', async () => {
  setNativeSurfaceVisible(false);
  const fake = createFake();
  const seen: boolean[] = [];
  const stop = trackSurfaceVisibility(fake.adapter, value => { seen.push(value); setNativeSurfaceVisible(value); });
  await flush();
  expect(seen).toEqual([true]);
  expect(isSurfaceVisible()).toBe(true);
  stop();
});
it('recovers visible on startup query failure, but respects known hidden page state', async () => {
  for (const hidden of [false, true]) {
    setNativeSurfaceVisible(false);
    const fake = createFake({ pageHidden: hidden });
    const seen: boolean[] = [];
    const stop = trackSurfaceVisibility({ ...fake.adapter, isShown: async () => { throw Error('no window'); }, isMinimized: async () => { throw Error('no window'); } }, value => { seen.push(value); setNativeSurfaceVisible(value); });
    await flush();
    expect(seen).toEqual([!hidden]);
    expect(isSurfaceVisible()).toBe(!hidden);
    stop();
  }
});

it('keeps a known minimized state when a later query fails', async () => {
  const fake = createFake({ minimized: true });
  const { seen, stop } = await start(fake);
  fake.adapter.isMinimized = async () => { throw Error('no window'); };
  fake.restore();
  await flush();
  expect(seen).toEqual([false]);
  stop();
});
