/** What the follower needs from the window; injectable so the ordering is testable without Tauri. */
export interface SurfaceIntentAdapter {
  /** Registers the `surface-intent` listener; resolves once it is really attached, with its stop function. */
  listen(handler: (intent: string) => void): Promise<() => void>;
  /** Pulls (and clears) the intent that was pending for this window, if any. */
  take(): Promise<string | null>;
}

const defaultReport = (what: string, error: unknown) => console.error(`[raio] ${what} failed`, error);

/**
 * Applies the intent a surface was shown with. The core holds the intent as pending until this window
 * pulls it, and only emits later intents as events, so the order here is: attach the listener, wait for
 * it to be live, then pull once. An event that arrives while the pull is in flight and carries the same
 * intent is not applied a second time. Returns the stop function.
 */
export const followSurfaceIntent = (
  adapter: SurfaceIntentAdapter,
  apply: (intent: string) => void,
  report: (what: string, error: unknown) => void = defaultReport,
): (() => void) => {
  let disposed = false;
  let pulling = true;
  const deliveredWhilePulling = new Set<string>();
  let stop: (() => void) | null = null;

  const onEvent = (intent: string) => {
    if (disposed) return;
    if (pulling) deliveredWhilePulling.add(intent);
    apply(intent);
  };

  void (async () => {
    try {
      const stopListening = await adapter.listen(onEvent);
      if (disposed) return stopListening();
      stop = stopListening;
    } catch (error) {
      report('surface-intent listen', error);
    }
    if (disposed) return;
    try {
      const pending = await adapter.take();
      if (!disposed && pending !== null && !deliveredWhilePulling.has(pending)) apply(pending);
    } catch (error) {
      report('take_surface_intent', error);
    } finally {
      pulling = false;
      deliveredWhilePulling.clear();
    }
  })();

  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
};
