import { useEffect, useState } from 'react';
import { runWindowAction, type TitleBarWindowApi } from './TitleBar';

/** Event-driven real window state; Activity disconnects this effect while the surface is hidden. */
export const WindowCaption = ({ nativeWindow }: { readonly nativeWindow: TitleBarWindowApi }) => {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    const report = (error: unknown) => { if (!disposed) console.warn('Raio window state unavailable', error); };
    const refresh = () => {
      if (disposed) return;
      const current = ++revision;
      void nativeWindow.isMaximized().then(value => {
        if (!disposed && current === revision) setMaximized(value);
      }).catch(report);
    };
    // Subscribe before reading to avoid missing an OS change during the initial query.
    void nativeWindow.onResized(refresh).then(stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      refresh();
    }).catch(report);
    return () => { disposed = true; unlisten?.(); };
  }, [nativeWindow]);
  const maximizeLabel = maximized ? 'Restore' : 'Maximize';
  const closeLabel = 'Close (Raio keeps running; quit from the tray)';
  const closeTooltip = 'Close to tray · quit from the tray menu';
  return <div className="titlebar__caption" role="group" aria-label="Window controls">
    <button type="button" className="titlebar__control" aria-label="Minimize" title="Minimize" onClick={() => runWindowAction(() => nativeWindow.minimize())}>
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
    </button>
    <button type="button" className="titlebar__control" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => runWindowAction(() => nativeWindow.toggleMaximize())}>
      <svg viewBox="0 0 10 10" aria-hidden="true" data-window-glyph={maximized ? 'restore' : 'maximize'}>
        {maximized ? <><rect x="2.5" y="0.5" width="7" height="7" /><rect x="0.5" y="2.5" width="7" height="7" /></> : <rect x="0.5" y="0.5" width="9" height="9" />}
      </svg>
    </button>
    <button type="button" className="titlebar__control titlebar__control--close" aria-label={closeLabel} aria-description={closeTooltip} title={closeTooltip} onClick={() => runWindowAction(() => nativeWindow.close())}>
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
    </button>
  </div>;
};
