import { useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { ConnectPreview, Connector } from '../../platform/desktopBridge';
import { ConnectReview } from './ConnectPanel';

/** "Connected to <project> · Disconnect" at the end of the sidebar (native only). */
export const ConnectionFooter = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project, connector.project);
  const readHooks = () => bridge.projectHooksState?.() ?? 'unknown';
  const hooks = useSyncExternalStore(bridge.subscribe, readHooks, readHooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ projectId: string; root: string; preview: ConnectPreview } | null>(null);
  if (!project) return null;
  const currentReview = review?.projectId === project.id && review.root === project.root ? review : null;
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
            setReview({ projectId: project.id, root: project.root, preview });
          }
        }).catch((e: unknown) => setError(String(e))).finally(() => setBusy(false));
      }}>Reconnect</button>
    </p>}
    {currentReview && <ConnectReview preview={currentReview.preview} busy={busy} onCancel={() => setReview(null)} onConnect={() => {
      const connected = connector.project();
      if (connected?.id !== currentReview.projectId || connected.root !== currentReview.root) {
        setReview(null);
        return;
      }
      setBusy(true);
      setError(null);
      void connector.connect(currentReview.root, currentReview.preview).then(() => setReview(null))
        .catch((e: unknown) => setError(String(e))).finally(() => setBusy(false));
    }} />}
    </>
  );
};
