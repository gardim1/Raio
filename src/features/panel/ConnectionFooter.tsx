import { useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectedProject, ConnectPreview, Connector } from '../../platform/desktopBridge';
import { ConnectReview } from './ConnectPanel';

/** "Connected to <project> · Disconnect" at the end of the sidebar (native only). */
export const ConnectionFooter = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project, connector.project);
  // A new connection identity owns new local state, so returning to a project cannot revive an old preview.
  return project ? <ConnectedFooter key={JSON.stringify([project.id, project.root])} project={project} connector={connector} /> : null;
};

const ConnectedFooter = ({ project, connector }: { readonly project: ConnectedProject; readonly connector: Connector }) => {
  const bridge = useBridge();
  const readHooks = () => bridge.projectHooksState?.() ?? 'unknown';
  const hooks = useSyncExternalStore(bridge.subscribe, readHooks, readHooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ConnectPreview | null>(null);
  return (
    <>
    <p className="evidence__note">
      Connected to {project.name} ·{' '}
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
      {error && <span className="evidence__warn"> {error}</span>}
    </p>
    {hooks === 'outdated' && <p className="evidence__warn">
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
