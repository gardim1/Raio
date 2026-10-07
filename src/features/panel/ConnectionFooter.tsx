import { useState, useSyncExternalStore } from 'react';
import { useBridge } from '../../platform/BridgeContext';
import type { Connector } from '../../platform/desktopBridge';

/** "Connected to <project> · Disconnect" at the end of the sidebar (native only). */
export const ConnectionFooter = ({ connector }: { readonly connector: Connector }) => {
  const bridge = useBridge();
  const project = useSyncExternalStore(bridge.subscribe, connector.project, connector.project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  return (
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
  );
};
