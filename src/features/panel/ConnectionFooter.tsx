import { useState } from 'react';
import { useSurfaceStore } from '../../shared/motion/visibleStore';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectedProject, ConnectPreview, Connector } from '../../platform/desktopBridge';
import { ConnectReview } from './ConnectPanel';

/** Compact project controls, without repeating the folder name. */
export const ConnectionFooter = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSurfaceStore(bridge.subscribe, connector.project);
  // A new connection identity owns new local state, so returning to a project cannot revive an old preview.
  return project ? <ConnectedFooter key={JSON.stringify([project.id, project.root])} project={project} connector={connector} /> : null;
};

const ConnectedFooter = ({ project, connector }: { readonly project: ConnectedProject; readonly connector: Connector }) => {
  const bridge = useBridge();
  const readHooks = () => bridge.projectHooksState?.() ?? 'unknown';
  const hooks = useSurfaceStore(bridge.subscribe, readHooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ConnectPreview | null>(null);
  return (
    <>
    <div className="project-controls" aria-label="Project controls" title={project.root}>
      <button
        type="button"
        className="link-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void connector
            .disconnect()
            .catch((e: unknown) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        Disconnect
      </button>
    </div>
    {error && <p className="evidence__warn" role="alert">{error}</p>}
    {hooks === 'outdated' && <p className="evidence__warn" role="status" aria-label="Hooks out of date">
      Raio's hooks for this project are out of date — reconnect to capture PowerShell checks.{' '}
      <button type="button" className="link-btn" disabled={busy} onClick={() => {
        setBusy(true);
        setError(null);
        void connector.preview(project.root).then((preview) => {
          const connected = connector.project();
          if (connected?.id === project.id && connected.root === project.root) {
            setReview(preview);
          }
        }).catch((e: unknown) => setError(String(e))).finally(() => setBusy(false));
      }}>Reconnect</button>
    </p>}
    {review && <ConnectReview preview={review} sidebar busy={busy} onCancel={() => setReview(null)} onConnect={() => {
      const connected = connector.project();
      if (connected?.id !== project.id || connected.root !== project.root) {
        setReview(null);
        return;
      }
      setBusy(true);
      setError(null);
      void connector.connect(project.root, review).then(() => setReview(null))
        .catch((e: unknown) => setError(String(e))).finally(() => setBusy(false));
    }} />}
    </>
  );
};
