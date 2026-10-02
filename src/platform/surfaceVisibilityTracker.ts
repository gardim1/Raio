type Unlisten = () => void;

/** The native window and document facts the tracker needs; faked in tests, Tauri/DOM in the app. */
export interface SurfaceWindowAdapter {
  isShown: () => Promise<boolean>;
  isMinimized: () => Promise<boolean>;
  /** The app's own `surface-visible` event. */
  onShownChanged: (handler: (shown: boolean) => void) => Promise<Unlisten>;
  /** Anything that can change minimized state (a minimize also resizes the window). */
  onWindowChanged: (handler: () => void) => Promise<Unlisten>;
  isPageHidden: () => boolean;
  onPageVisibilityChanged: (handler: () => void) => Unlisten;
}

/**
 * Folds "shown by the app", "not minimized" and "document not hidden" into one visible flag, so a
 * minimized or occluded window stops animating like a window the app hid. Calls `apply` only when the
 * combined flag changes. Returns a function that stops tracking.
 */
export const trackSurfaceVisibility = (adapter: SurfaceWindowAdapter, apply: (visible: boolean) => void): Unlisten => {
  let shown = true;
  let minimized = false;
  let pageHidden = adapter.isPageHidden();
  let stopped = false;
  let shownEventSeen = false;
  let minimizedQuery = 0;
  let lastApplied = true;
  const unlisteners: Unlisten[] = [];

  const publish = () => {
    if (stopped) return;
    const visible = shown && !minimized && !pageHidden;
    if (visible === lastApplied) return;
    lastApplied = visible;
    apply(visible);
  };

  const refreshMinimized = () => {
    const query = ++minimizedQuery;
    adapter
      .isMinimized()
      .then((value) => {
        if (query !== minimizedQuery) return;
        minimized = value;
        publish();
      })
      .catch(() => {});
  };

  const track = (registration: Promise<Unlisten>) => {
    registration
      .then((unlisten) => {
        if (stopped) unlisten();
        else unlisteners.push(unlisten);
      })
      .catch(() => {});
  };

  track(
    adapter.onShownChanged((value) => {
      shownEventSeen = true;
      shown = value;
      publish();
    }),
  );
  track(adapter.onWindowChanged(refreshMinimized));
  unlisteners.push(
    adapter.onPageVisibilityChanged(() => {
      pageHidden = adapter.isPageHidden();
      publish();
    }),
  );

  // Floating surfaces start hidden; a later event is newer than this answer and wins.
  adapter
    .isShown()
    .then((value) => {
      if (shownEventSeen) return;
      shown = value;
      publish();
    })
    .catch(() => {});
  refreshMinimized();
  publish();

  return () => {
    stopped = true;
    unlisteners.splice(0).forEach((unlisten) => unlisten());
  };
};
